/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

var XChainWS = {

    // State
    ws:                   null,
    url:                  null,
    coin:                 null,
    subscriptions:        [],
    lastActionIndex:      0,
    reconnectAttempts:    0,
    maxReconnectAttempts: 10,
    reconnectDelay:       1000,
    maxReconnectDelay:    30000,
    pingInterval:         null,
    pingIntervalMs:       25000,
    intentionalClose:     false,
    serverInfo:           null,
    catchingUp:           false,
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

        // Track latest action_index for catch-up on reconnect
        if (msg.data && msg.data.action_index) {
            var idx = Number(msg.data.action_index);
            if (idx > this.lastActionIndex) {
                this.lastActionIndex = idx;
            }
        }
        // Also track from latest_action_index in WELCOME and CATCH_UP_COMPLETE
        if (msg.data && msg.data.latest_action_index) {
            var latestIdx = Number(msg.data.latest_action_index);
            if (latestIdx > this.lastActionIndex) {
                this.lastActionIndex = latestIdx;
            }
        }

        // Handle system messages
        if (msg.type === 'WELCOME') {
            this.serverInfo = msg.data;
            console.log('[XChainWS] Server v' + msg.data.version,
                '| block:', msg.data.latest_block_index,
                '| action:', msg.data.latest_action_index);
            if (this.lastActionIndex === 0 && msg.data.latest_action_index) {
                this.lastActionIndex = msg.data.latest_action_index;
            }
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
        // The close event follows — status update happens there
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

    // Resubscribe to all tracked subscriptions (after reconnect)
    _resubscribe: function() {
        if (this.subscriptions.length === 0) {
            this._autoSubscribe();
            return;
        }
        for (var i = 0; i < this.subscriptions.length; i++) {
            var sub    = this.subscriptions[i];
            var params = Object.assign({}, sub.params);
            if (this.lastActionIndex > 0) {
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
            // Create indicator — small dot in the navbar
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
                el.title = 'Live — connected';
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
