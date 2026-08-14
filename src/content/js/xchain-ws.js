/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - WebSocket Client
 *
 * WebSocket client using the native browser WebSocket API.
 * Connects to the explorer's WebSocket server, manages subscriptions,
 * handles reconnection with catch-up, and provides a connection
 * status indicator.
 *
 ********************************************************************/

// WS event-envelope schema version this bundled browser client understands.
// This file is a plain, un-bundled browser script (served via express.static,
// no require()), so it cannot import src/ws/schema-version.js's WS_SCHEMA_VERSION
// directly; keep this literal in sync with that constant by hand. A conformance
// test (test/unit/ws/schema-version-client.test.js) fails the build if they drift.
var CLIENT_WS_SCHEMA_VERSION = 2;

var XChainWS = {

    // State
    ws:                   null,
    url:                  null,
    coin:                 null,
    subscriptions:        [],
    // Exact decimal STRING from the v2 wire, or null when unseeded. Number() rounded
    // it above 2^53 and the rounded value went back out as since_action_index, so a
    // reconnect asked for rows after an action never delivered.
    lastActionIndex:      null,
    reconnectAttempts:    0,
    maxReconnectAttempts: 10,
    reconnectDelay:       1000,
    maxReconnectDelay:    30000,
    pingInterval:         null,
    pingIntervalMs:       25000,
    intentionalClose:     false,
    serverInfo:           null,
    catchingUp:           false,
    _schemaWarned:        false,
    handlers:             {},

    // Connect to the WebSocket server for a given coin
    connect: function(coin) {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.coin = coin;
        this.intentionalClose = false;
        this._setStatus('connecting');

        // Build WebSocket URL from current page location
        var protocol = (location.protocol === 'https:') ? 'wss:' : 'ws:';
        this.url = protocol + '//' + location.host + '/' + coin + '/api/websocket';

        try {
            this.ws = new WebSocket(this.url);
        } catch (e) {
            console.log('[XChainWS] Connection error:', e);
            this._setStatus('disconnected');
            this._reconnect();
            return;
        }

        this.ws.onopen    = this._onOpen.bind(this);
        this.ws.onmessage = this._onMessage.bind(this);
        this.ws.onclose   = this._onClose.bind(this);
        this.ws.onerror   = this._onError.bind(this);
    },

    // Disconnect intentionally
    disconnect: function() {
        this.intentionalClose = true;
        this._stopPing();
        this._setStatus('disconnected');
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    },

    // Register an event handler
    on: function(eventType, callback) {
        if (!this.handlers[eventType]) {
            this.handlers[eventType] = [];
        }
        this.handlers[eventType].push(callback);
    },

    // Remove an event handler
    off: function(eventType, callback) {
        if (!this.handlers[eventType]) return;
        this.handlers[eventType] = this.handlers[eventType].filter(function(cb) {
            return cb !== callback;
        });
    },

    // Subscribe to channels with optional filters
    subscribe: function(channels, params) {
        var msg = { action: 'subscribe', channels: channels };
        if (params) msg.params = params;
        // Track for resubscribe on reconnect
        this.subscriptions.push({ channels: channels, params: params || {} });
        this._send(msg);
    },

    // Unsubscribe from channels
    unsubscribe: function(channels, params) {
        var msg = { action: 'unsubscribe', channels: channels };
        if (params) msg.params = params;
        // Remove from tracked subscriptions
        this.subscriptions = this.subscriptions.filter(function(sub) {
            return JSON.stringify(sub.channels) !== JSON.stringify(channels) ||
                   JSON.stringify(sub.params) !== JSON.stringify(params || {});
        });
        this._send(msg);
    },

    // List current subscriptions
    listSubscriptions: function() {
        this._send({ action: 'list_subscriptions' });
    },

    // Send a JSON message to the server
    _send: function(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    },

    // Handle connection open
    _onOpen: function() {
        console.log('[XChainWS] Connected to', this.url);
        this.reconnectAttempts = 0;
        this._schemaWarned = false;
        this._setStatus('connected');
        this._startPing();
        this._resubscribe();
    },

    // Handle incoming message
    _onMessage: function(event) {
        var msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        // Track latest action_index for catch-up on reconnect. WELCOME's and
        // CATCH_UP_COMPLETE's latest_action_index ride the same path, so the seed and
        // the running maximum cannot drift apart.
        if (msg.data) {
            this._advanceCursor(msg.data.action_index);
            this._advanceCursor(msg.data.latest_action_index);
        }

        // Envelope schema gate: the server stamps every frame with
        // schema_version (distinct from the build version). If the server
        // speaks a NEWER envelope schema than this client knows, payload
        // shapes may have changed; warn once instead of silently mis-parsing.
        if (msg.schema_version !== undefined && msg.schema_version > CLIENT_WS_SCHEMA_VERSION && !this._schemaWarned) {
            this._schemaWarned = true;
            console.warn('[XChainWS] Server WS schema_version ' + msg.schema_version +
                ' is newer than this client understands (' + CLIENT_WS_SCHEMA_VERSION + '); event payload shapes may have changed.');
        }

        // Handle system messages
        if (msg.type === 'WELCOME') {
            this.serverInfo = msg.data;
            // Constant format string with the server-supplied values passed as
            // separate arguments, not concatenated in: a WELCOME frame's fields
            // are server data, but console.log must never take a caller-shaped
            // string as its own first argument.
            console.log('[XChainWS] Server v%s | block: %s | action: %s',
                msg.data.version, msg.data.latest_block_index, msg.data.latest_action_index);
        }

        // Track catch-up state
        if (msg.catch_up) {
            if (!this.catchingUp) {
                this.catchingUp = true;
                console.log('[XChainWS] Catching up on missed events...');
            }
        }
        if (msg.type === 'CATCH_UP_COMPLETE') {
            this.catchingUp = false;
            console.log('[XChainWS] Catch-up complete:', msg.data.events_replayed, 'events replayed');
        }

        // Dispatch to registered handlers
        if (msg.type && this.handlers[msg.type]) {
            for (var i = 0; i < this.handlers[msg.type].length; i++) {
                try {
                    this.handlers[msg.type][i](msg);
                } catch (e) {
                    console.log('[XChainWS] Handler error for', msg.type, ':', e);
                }
            }
        }

        // Dispatch to wildcard handlers
        if (this.handlers['*']) {
            for (var j = 0; j < this.handlers['*'].length; j++) {
                try {
                    this.handlers['*'][j](msg);
                } catch (e) {
                    // ignore
                }
            }
        }
    },

    // Handle connection close
    _onClose: function(event) {
        console.log('[XChainWS] Disconnected (code:', event.code + ')');
        this._stopPing();
        this.ws = null;

        if (!this.intentionalClose) {
            this._setStatus('reconnecting');
            this._reconnect();
        } else {
            this._setStatus('disconnected');
        }
    },

    // Handle connection error
    _onError: function() {
        // The close event follows; status update happens there
    },

    // Reconnect with exponential backoff and jitter
    _reconnect: function() {
        if (this.intentionalClose) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('[XChainWS] Max reconnect attempts reached');
            this._setStatus('disconnected');
            this._dispatch('connection_lost', {});
            return;
        }

        var attempt = this.reconnectAttempts++;
        var delay = Math.min(
            this.maxReconnectDelay,
            this.reconnectDelay * Math.pow(2, attempt)
        ) + Math.floor(Math.random() * 1000);

        console.log('[XChainWS] Reconnecting in', Math.round(delay / 1000) + 's (attempt', (attempt + 1) + ')');

        var self = this;
        setTimeout(function() {
            self.connect(self.coin);
        }, delay);
    },

    // Start application-level ping
    _startPing: function() {
        this._stopPing();
        var self = this;
        this.pingInterval = setInterval(function() {
            self._send({ action: 'ping' });
        }, this.pingIntervalMs);
    },

    // Stop ping interval
    _stopPing: function() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    },

    // Advance the catch-up cursor to `raw` when it is higher, comparing as BigInt so
    // two consecutive indices above 2^53 stay distinct. Stores the wire's own decimal
    // string; nothing here converts to Number, and a value that is not a non-negative
    // integer literal is not a cursor and is ignored (this also absorbs null).
    _advanceCursor: function(raw) {
        if (raw === null || raw === undefined) return;
        var val = String(raw);
        if (!/^[0-9]+$/.test(val)) return;
        if (this.lastActionIndex === null || BigInt(val) > BigInt(this.lastActionIndex)) {
            this.lastActionIndex = val;
        }
    },

    // Resubscribe to all tracked subscriptions (after reconnect)
    _resubscribe: function() {
        if (this.subscriptions.length === 0) {
            this._autoSubscribe();
            return;
        }
        for (var i = 0; i < this.subscriptions.length; i++) {
            var sub    = this.subscriptions[i];
            var params = Object.assign({}, sub.params);
            // Same gate as before the cursor became a string: a chain still at index 0
            // gets no since_action_index.
            if (this.lastActionIndex !== null && BigInt(this.lastActionIndex) > 0n) {
                params.since_action_index = this.lastActionIndex;
            }
            this._send({ action: 'subscribe', channels: sub.channels, params: params });
        }
    },

    // Auto-subscribe to page-relevant channels
    _autoSubscribe: function() {
        this.subscribe(['blocks', 'network']);
    },

    // Update the connection status indicator in the page header
    _setStatus: function(state) {
        // Find or create the status indicator element
        var el = document.getElementById('xchain-ws-status');
        if (!el) {
            // Create indicator (small dot in the navbar)
            var navbar = document.querySelector('.navbar .container');
            if (!navbar) return;
            el = document.createElement('span');
            el.id = 'xchain-ws-status';
            el.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:8px;vertical-align:middle;transition:background-color 0.3s;';
            el.title = 'WebSocket status';
            navbar.appendChild(el);
        }

        switch (state) {
            case 'connected':
                el.style.backgroundColor = '#28a745';
                el.title = 'Live (connected)';
                break;
            case 'connecting':
            case 'reconnecting':
                el.style.backgroundColor = '#ffc107';
                el.title = 'Reconnecting...';
                break;
            case 'disconnected':
                el.style.backgroundColor = '#dc3545';
                el.title = 'Disconnected';
                break;
            default:
                el.style.backgroundColor = '#6c757d';
                el.title = 'Unknown';
        }
    },

    // Dispatch a synthetic event to handlers
    _dispatch: function(type, data) {
        var msg = { type: type, timestamp: Date.now(), data: data };
        if (this.handlers[type]) {
            for (var i = 0; i < this.handlers[type].length; i++) {
                try {
                    this.handlers[type][i](msg);
                } catch (e) {
                    // ignore
                }
            }
        }
    }
};
