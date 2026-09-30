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
// no require()), so it cannot import src/ws/schema_version.js's WS_SCHEMA_VERSION
// directly; keep this literal in sync with that constant by hand. A conformance
// test (test/unit/ws/schema_version_client.test.js) fails the build if they drift.
var CLIENT_WS_SCHEMA_VERSION = 2;

// Track latest action_index for catch-up on reconnect. WELCOME only seeds an unset
// cursor: its tip runs ahead of rows a reconnect replay has yet to deliver. While that
// replay runs, frames are noted in _catchUp.maxSeen and applied once it closes.
function xcWsTrackCursor(client, msg) {
    if (!msg.data) return;
    if (msg.type === 'WELCOME') {
        if (client.lastActionIndex === null) client._advanceCursor(msg.data.latest_action_index);
        return;
    }
    if (client._catchUp) {
        client._catchUp.maxSeen = xcWsMaxIndex(client._catchUp.maxSeen, msg.data.action_index);
        client._catchUp.maxSeen = xcWsMaxIndex(client._catchUp.maxSeen, msg.data.latest_action_index);
        return;
    }
    client._advanceCursor(msg.data.action_index);
    client._advanceCursor(msg.data.latest_action_index);
}

// The larger of two action indexes, compared as BigInt and kept as the wire's decimal
// string. A value that is not a non-negative integer literal is ignored (null included).
function xcWsMaxIndex(current, raw) {
    if (raw === null || raw === undefined) return current;
    var val = String(raw);
    if (!/^[0-9]+$/.test(val)) return current;
    return (current === null || BigInt(val) > BigInt(current)) ? val : current;
}

// Envelope schema gate: the server stamps every frame with
// schema_version (distinct from the build version). If the server
// speaks a NEWER envelope schema than this client knows, payload
// shapes may have changed; warn once instead of silently mis-parsing.
function xcWsCheckSchema(client, msg) {
    if (msg.schema_version !== undefined && msg.schema_version > CLIENT_WS_SCHEMA_VERSION && !client._schemaWarned) {
        client._schemaWarned = true;
        XCLogger.warn('[XChainWS] Server WS schema_version ' + msg.schema_version +
            ' is newer than this client understands (' + CLIENT_WS_SCHEMA_VERSION + '); event payload shapes may have changed.');
    }
}

// Handle system messages
function xcWsHandleSystemMessage(client, msg) {
    if (msg.type === 'WELCOME') {
        client.serverInfo = msg.data;
        // Constant format string with the server-supplied values passed as
        // separate arguments, not concatenated in: a WELCOME frame's fields
        // are server data, but console.log must never take a caller-shaped
        // string as its own first argument.
        XCLogger.log('[XChainWS] Server v%s | block: %s | action: %s',
            msg.data.version, msg.data.latest_block_index, msg.data.latest_action_index);
    }

    // Track catch-up state
    if (msg.catch_up) {
        if (!client.catchingUp) {
            client.catchingUp = true;
            XCLogger.log('[XChainWS] Catching up on missed events...');
        }
    }
    if (msg.type === 'CATCH_UP_COMPLETE') {
        client.catchingUp = false;
        XCLogger.log('[XChainWS] Catch-up complete:', msg.data.events_replayed, 'events replayed');
    }

    // A COMPLETE or an error carrying the pending catch-up's id moves the reconnect on.
    if (client._catchUp && (msg.type === 'CATCH_UP_COMPLETE' || msg.type === 'error')) {
        client._catchUpAnswered(msg);
    }
}

// Dispatch to registered handlers
function xcWsDispatchMessage(client, msg) {
    if (msg.type && client.handlers[msg.type]) {
        for (var i = 0; i < client.handlers[msg.type].length; i++) {
            try {
                client.handlers[msg.type][i](msg);
            } catch (e) {
                XCLogger.log('[XChainWS] Handler error for', msg.type, ':', e);
            }
        }
    }

    // Dispatch to wildcard handlers
    if (client.handlers['*']) {
        for (var j = 0; j < client.handlers['*'].length; j++) {
            try {
                client.handlers['*'][j](msg);
            } catch (e) {
                // ignore
            }
        }
    }
}

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
    // The reconnect catch-up in progress, or null. It and the methods that drive it
    // live in xchain_ws_catch_up.js, which the page loads right after this file.
    _catchUp:             null,
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
            XCLogger.log('[XChainWS] Connection error:', e);
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
        XCLogger.log('[XChainWS] Connected to', this.url);
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

        xcWsTrackCursor(this, msg);
        xcWsCheckSchema(this, msg);
        xcWsHandleSystemMessage(this, msg);
        xcWsDispatchMessage(this, msg);
    },

    // Handle connection close
    _onClose: function(event) {
        XCLogger.log('[XChainWS] Disconnected (code:', event.code + ')');
        this._stopPing();
        this.ws = null;
        // Drop an unfinished catch-up WITHOUT applying what it saw: the cursor still
        // points before the gap, so the next reconnect replays it again from there.
        if (this._catchUp && this._catchUp.timer) clearTimeout(this._catchUp.timer);
        this._catchUp = null;

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
            XCLogger.log('[XChainWS] Max reconnect attempts reached');
            this._setStatus('disconnected');
            this._dispatch('connection_lost', {});
            return;
        }

        var attempt = this.reconnectAttempts++;
        var delay = Math.min(
            this.maxReconnectDelay,
            this.reconnectDelay * Math.pow(2, attempt)
        ) + Math.floor(Math.random() * 1000);

        XCLogger.log('[XChainWS] Reconnecting in', Math.round(delay / 1000) + 's (attempt', (attempt + 1) + ')');

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
        this.lastActionIndex = xcWsMaxIndex(this.lastActionIndex, raw);
    },

    // _resubscribe (after reconnect) is installed by xchain_ws_catch_up.js, which sends
    // each subscription's catch-up one at a time.

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
