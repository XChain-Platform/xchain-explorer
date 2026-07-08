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
 * XChain Explorer - WebSocket Server
 *
 * Handles WebSocket connections on /{COIN}/api/websocket, parses
 * the coin prefix from the URL, sends WELCOME messages, and manages
 * connection lifecycle including ping/pong keepalive.
 *
 ********************************************************************/

const { WebSocketServer: WSServer } = require('ws');
const ChannelManager = require('./ChannelManager.js');
// BigInt-safe JSON serializer (shared with Broadcaster via serialize.js). _send
// previously used raw JSON.stringify, which throws on BigInt DB columns; under the
// swallowing try/catch that silently dropped every message carrying a raw DB row.
const { safeStringify } = require('./serialize.js');

// Regex to match /{COIN}/api/websocket path
const WS_PATH_REGEX = /^\/([A-Z]{1,5})\/api\/websocket$/i;

class WebSocketServer {

    constructor(options) {
        this.explorer    = options.explorer;
        this.broadcaster = options.broadcaster;

        // Configuration
        this.pingInterval    = options.pingInterval    || 30000;
        this.idleTimeout     = options.idleTimeout     || 300000;
        this.maxPerIp        = options.maxPerIp        || 5;
        // Number of trusted proxy hops in front of the server, mirroring the HTTP
        // side's Express `trust proxy` setting. The WS upgrade is handled on the raw
        // HTTP server (Express trust-proxy does NOT apply here), so the per-IP cap key
        // must resolve the client address the same way: with 0 trusted hops, ignore
        // X-Forwarded-For entirely (use the TCP peer); with N, take the entry N from the
        // right (the address the outermost trusted proxy observed). Never trust the
        // leftmost/client-supplied XFF token.
        this.trustProxyHops  = Number.isInteger(options.trustProxyHops) ? options.trustProxyHops : 0;
        this.maxMessageSize  = options.maxMessageSize  || 1024;
        this.maxMsgPerSec    = options.maxMsgPerSec    || 10;
        this.catchUpMaxDepth = options.catchUpMaxDepth || 1000;
        this.catchUpMaxEvents = options.catchUpMaxEvents || 100;

        // Channel manager for subscription tracking
        this.channelManager = new ChannelManager({
            maxSubscriptions: options.maxSubscriptions || 25
        });

        // State
        this.clients    = new Map();  // clientId -> client object
        this.ipCounts   = new Map();  // ip -> connection count
        this.nextId     = 1;
        this.wss        = null;
        this.pingTimer  = null;
        this.idleTimer  = null;

        // Valid coin prefixes derived from config
        this.validCoins = null; // populated on first connection from explorer config
    }

    // Attach to HTTP and/or HTTPS servers
    attach(servers) {
        // Create a noServer WSS (we handle upgrade manually for path filtering)
        this.wss = new WSServer({ noServer: true });

        this.wss.on('connection', (ws, req, clientInfo) => {
            this._onConnection(ws, req, clientInfo);
        });

        // Attach upgrade handler to each server
        for (const server of servers) {
            server.on('upgrade', (req, socket, head) => {
                this._handleUpgrade(req, socket, head);
            });
        }

        // Start ping interval
        this._startPingInterval();

        console.log('WebSocket server attached on /{COIN}/api/websocket');
    }

    // Graceful shutdown
    stop() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.idleTimer) {
            clearInterval(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.wss) {
            for (const [, client] of this.clients) {
                client.ws.close(1001, 'Server shutting down');
            }
            this.wss.close();
        }
    }

    // Get all connected clients (used by Broadcaster)
    getClients() {
        return this.clients;
    }

    // Resolve the client IP used to key the per-IP connection cap. The leftmost
    // X-Forwarded-For token is fully client-supplied (real proxies APPEND the observed
    // peer to the right), so keying on it let an attacker send a unique XFF per upgrade
    // and open unbounded connections. With trustProxyHops=N>0, take the entry N from the
    // right (the address the outermost trusted proxy inserted); otherwise, and whenever
    // XFF is absent or malformed, fall back to the unspoofable TCP peer address.
    _clientIp(req) {
        const hops = this.trustProxyHops;
        const xff  = req.headers['x-forwarded-for'];
        if (hops > 0 && xff) {
            const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
            const idx   = parts.length - hops;
            if (idx >= 0 && parts[idx]) return parts[idx];
        }
        return req.socket.remoteAddress;
    }

    // Handle HTTP upgrade request: validate path and coin before upgrading
    _handleUpgrade(req, socket, head) {
        const match = WS_PATH_REGEX.exec(req.url);
        if (!match) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        const coinParam = match[1].toUpperCase();
        const coinInfo  = this._resolveCoin(coinParam);
        if (!coinInfo) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        // Per-IP connection limit
        const ip = this._clientIp(req);
        const currentCount = this.ipCounts.get(ip) || 0;
        if (currentCount >= this.maxPerIp) {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            socket.destroy();
            return;
        }

        // Complete the upgrade
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req, { coin: coinParam, ...coinInfo, ip });
        });
    }

    // Handle new WebSocket connection
    _onConnection(ws, req, clientInfo) {
        const clientId = this.nextId++;
        const client = {
            id:            clientId,
            ws:            ws,
            coin:          clientInfo.coin,
            chain:         clientInfo.chain,
            network:       clientInfo.network,
            ip:            clientInfo.ip,
            subscriptions:    new Set(),
            lastActivity:     Date.now(),
            alive:            true,
            msgCount:         0,
            msgWindowStart:   Date.now(),
            catchUpInProgress: false,
            snapshotInProgress: false,
            backpressureSkips: 0
        };

        this.clients.set(clientId, client);
        this.ipCounts.set(clientInfo.ip, (this.ipCounts.get(clientInfo.ip) || 0) + 1);

        // Set max message size
        ws._maxPayload = this.maxMessageSize;

        this._log('connect', clientId, { coin: clientInfo.coin, ip: clientInfo.ip });

        // Send WELCOME
        this._sendWelcome(client);

        // Wire up event handlers
        ws.on('message', (data) => this._onMessage(client, data));
        ws.on('close', ()      => this._onClose(client));
        ws.on('error', (err)   => this._onError(client, err));
        ws.on('pong', ()       => { client.alive = true; });
    }

    // Send WELCOME message with server info
    async _sendWelcome(client) {
        // Get latest indexes from the database
        let latestBlockIndex  = 0;
        let latestActionIndex = 0;
        try {
            const db     = this.explorer.db;
            const config = { coin: client.coin };
            latestBlockIndex  = await db.getMaxBlockIndex(config) || 0;
            latestActionIndex = await db.getMaxActionIndex(config) || 0;
        } catch (e) {
            // Non-fatal: send WELCOME with zeros
        }

        const welcome = {
            type:      'WELCOME',
            chain:     client.chain,
            network:   client.network,
            timestamp: Date.now(),
            data: {
                version:              this.explorer.version || '1.0.0',
                server_time:          Date.now(),
                latest_block_index:   latestBlockIndex,
                latest_action_index:  latestActionIndex,
                limits: {
                    max_subscriptions:      this.channelManager.maxSubscriptions,
                    max_message_rate:       this.maxMsgPerSec,
                    max_message_size:       this.maxMessageSize,
                    max_connections_per_ip: this.maxPerIp
                },
                channels: ['blocks', 'actions', 'mempool', 'network', 'attestation', 'address', 'token', 'market', 'dispenser'],
                types: [
                    'ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE',
                    'COINPAY', 'COINPAY_EXPIRE',
                    'SWAP', 'SWAP_MATCH', 'SWAP_EXPIRE',
                    'DISPENSER', 'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE',
                    'SEND', 'SWEEP', 'AIRDROP', 'DIVIDEND',
                    'ISSUE', 'MINT', 'DESTROY',
                    'BROADCAST', 'CALLBACK', 'FILE', 'MESSAGE', 'LIST', 'LINK', 'SLEEP',
                    'DEPLOY', 'EXECUTE', 'DEPOSIT', 'WITHDRAW',
                    'STAKE', 'UNSTAKE', 'DELEGATE', 'COLLECT', 'ATTEST',
                    'PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF'
                ],
                features: ['snapshot', 'once', 'fields', 'statuses', 'ticks', 'batch', 'catch_up']
            }
        };

        this._send(client, welcome);
    }

    // Handle incoming client message
    _onMessage(client, data) {
        client.lastActivity = Date.now();

        // Rate limiting: sliding 1-second window
        const now = Date.now();
        if (now - client.msgWindowStart > 1000) {
            client.msgCount      = 0;
            client.msgWindowStart = now;
        }
        client.msgCount++;
        if (client.msgCount > this.maxMsgPerSec) {
            this._sendError(client, 'RATE_LIMITED', 'Too many messages (max ' + this.maxMsgPerSec + '/sec)');
            return;
        }

        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            this._sendError(client, 'INVALID_ACTION', 'Malformed JSON');
            return;
        }

        if (!msg || typeof msg.action !== 'string') {
            this._sendError(client, 'INVALID_ACTION', 'Missing action field');
            return;
        }

        switch (msg.action) {
            case 'ping':
                this._send(client, {
                    type:      'pong',
                    timestamp: Date.now(),
                    data:      {}
                });
                break;

            case 'subscribe':
                this._handleSubscribe(client, msg);
                break;

            case 'unsubscribe':
                this._handleUnsubscribe(client, msg);
                break;

            case 'list_subscriptions':
                this._handleListSubscriptions(client, msg);
                break;

            default:
                this._sendError(client, 'INVALID_ACTION', `Unknown action: ${msg.action}`, msg.id);
                break;
        }
    }

    // Handle subscribe message
    _handleSubscribe(client, msg) {
        const channels = msg.channels;
        const params   = msg.params || {};

        if (!Array.isArray(channels) || channels.length === 0) {
            this._sendError(client, 'INVALID_CHANNEL', 'channels must be a non-empty array', msg.id);
            return;
        }

        // Snapshot the keys the client already holds BEFORE subscribing, so a snapshot
        // request only fires for entities newly added by THIS call (see below).
        const prevKeys = new Set(client.subscriptions);

        const result = this.channelManager.subscribe(client, channels, params);

        if (!result.success) {
            const err = result.error;
            this._sendError(client, err.code, err.message, msg.id);
            return;
        }

        // Send SUBSCRIBED confirmation for each entity subscribed
        for (const sub of result.subscribed) {
            const confirmation = {
                type:      'SUBSCRIBED',
                timestamp: Date.now(),
                data: {
                    channel: sub.channel,
                    active_filters: {
                        types:    result.filter.types    ? [...result.filter.types]    : null,
                        statuses: result.filter.statuses ? [...result.filter.statuses] : null,
                        ticks:    result.filter.ticks    ? [...result.filter.ticks]    : null,
                        fields:   result.filter.fields   ? [...result.filter.fields]   : null,
                        once:     result.filter.once
                    }
                }
            };
            // Copy entity identifiers into the data
            if (sub.address)      confirmation.data.address      = sub.address;
            if (sub.tick)         confirmation.data.tick          = sub.tick;
            if (sub.tick1)        confirmation.data.tick1         = sub.tick1;
            if (sub.tick2)        confirmation.data.tick2         = sub.tick2;
            if (sub.action_index !== undefined) confirmation.data.action_index = sub.action_index;
            // Echo request id if provided
            if (msg.id !== undefined) confirmation.id = msg.id;
            this._send(client, confirmation);
        }

        this._log('subscribe', client.id, { channels: channels.join(','), count: result.subscribed.length });

        // Handle snapshot requests. Only snapshot entities NEWLY subscribed on this
        // call: ChannelManager.subscribe returns already-active entities in
        // result.subscribed too (idempotent add), so without this filter a client could
        // re-send the same batch at the message-rate limit and re-trigger the full
        // per-entity snapshot DB fan-out every message (~50 queries/batch). A per-client
        // in-progress guard (like catch-up) bounds concurrent fan-outs to one batch.
        if (params.snapshot && !client.snapshotInProgress) {
            const fresh = result.subscribed.filter(sub =>
                !prevKeys.has(this.channelManager.channelKeyForSub(client.coin, sub)));
            if (fresh.length) {
                client.snapshotInProgress = true;
                Promise.resolve(this._sendSnapshots(client, fresh))
                    .catch(() => {})
                    .finally(() => { client.snapshotInProgress = false; });
            }
        }

        // Handle catch-up requests
        if (params.since_action_index !== undefined && params.since_action_index !== null) {
            this._handleCatchUp(client, params.since_action_index, result.filter, msg.id);
        }
    }

    // Handle unsubscribe message
    _handleUnsubscribe(client, msg) {
        const channels = msg.channels;
        const params   = msg.params || {};

        if (!Array.isArray(channels) || channels.length === 0) {
            this._sendError(client, 'INVALID_CHANNEL', 'channels must be a non-empty array', msg.id);
            return;
        }

        this.channelManager.unsubscribe(client, channels, params);
    }

    // Handle list_subscriptions message
    _handleListSubscriptions(client, msg) {
        const subs = this.channelManager.listSubscriptions(client);
        const response = {
            type:      'SUBSCRIPTION_LIST',
            timestamp: Date.now(),
            data: {
                count:         subs.length,
                limit:         this.channelManager.maxSubscriptions,
                subscriptions: subs
            }
        };
        if (msg.id !== undefined) response.id = msg.id;
        this._send(client, response);
    }

    // Handle catch-up replay of missed events
    async _handleCatchUp(client, sinceActionIndex, filter, requestId) {
        sinceActionIndex = Number(sinceActionIndex);

        // Check if catch-up already in progress
        if (client.catchUpInProgress) {
            this._sendError(client, 'CATCH_UP_IN_PROGRESS', 'A catch-up request is already running', requestId);
            return;
        }

        const db     = this.explorer.db;
        const config = { coin: client.coin };

        // Check depth: reject if too far behind
        try {
            const currentMax = await db.getMaxActionIndex(config) || 0;
            if (currentMax - sinceActionIndex > this.catchUpMaxDepth) {
                this._sendError(client, 'CATCH_UP_TOO_OLD',
                    `Requested action_index ${sinceActionIndex} is more than ${this.catchUpMaxDepth} behind current (${currentMax}). Use REST API to backfill.`,
                    requestId);
                return;
            }
        } catch (e) {
            this._sendError(client, 'CATCH_UP_TOO_OLD', 'Unable to determine current state', requestId);
            return;
        }

        client.catchUpInProgress = true;

        try {
            const actions = await db.getActionsSince(config, sinceActionIndex, this.catchUpMaxEvents);
            const info    = this._getCoinInfo(client.coin);
            let eventsReplayed = 0;
            const truncated = actions.length >= this.catchUpMaxEvents;

            for (const action of actions) {
                // Build catch-up event with catch_up flag
                const event = {
                    type:      'NEW_ACTION',
                    chain:     info.chain,
                    network:   info.network,
                    timestamp: Date.now(),
                    catch_up:  true,
                    data: {
                        action_index: action.action_index,
                        action:       action.action       || null,
                        tx_hash:      action.tx_hash      || null,
                        block_index:  action.block_index   || null,
                        source:       action.source        || null,
                        status:       action.status        || null
                    }
                };

                // Apply same filter pipeline as live events
                if (filter.types) {
                    const actionType = action.action || event.type;
                    if (!filter.types.has(actionType) && !filter.types.has(event.type)) continue;
                }
                if (filter.statuses && action.status && !filter.statuses.has(action.status)) continue;

                this._send(client, event);
                eventsReplayed++;
            }

            // Determine latest action index from replayed events
            const latestIdx = actions.length > 0
                ? Number(actions[actions.length - 1].action_index)
                : sinceActionIndex;

            // Send CATCH_UP_COMPLETE
            const complete = {
                type:      'CATCH_UP_COMPLETE',
                timestamp: Date.now(),
                data: {
                    events_replayed:    eventsReplayed,
                    latest_action_index: latestIdx,
                    truncated:          truncated
                }
            };
            if (requestId !== undefined) complete.id = requestId;
            this._send(client, complete);

        } catch (e) {
            console.error('Catch-up error for client', client.id, ':', e);
        } finally {
            client.catchUpInProgress = false;
        }
    }

    // Get chain/network info for a coin prefix
    _getCoinInfo(coin) {
        return this._resolveCoin(coin) || { chain: coin, network: 'mainnet' };
    }

    // Send snapshot data for subscribed entities
    async _sendSnapshots(client, subscribed) {
        const db     = this.explorer.db;
        const config = { coin: client.coin };

        for (const sub of subscribed) {
            try {
                let snapshotData = null;

                switch (sub.channel) {
                    case 'blocks': {
                        const maxBlock = await db.getMaxBlockIndex(config);
                        snapshotData = { channel: 'blocks', latest_block_index: maxBlock || 0 };
                        break;
                    }
                    case 'network': {
                        const maxBlock  = await db.getMaxBlockIndex(config);
                        const maxAction = await db.getMaxActionIndex(config);
                        snapshotData = { channel: 'network', block_height: maxBlock || 0, total_actions: maxAction || 0 };
                        break;
                    }
                    case 'address': {
                        const balances = await db.getAddressBalances(config, sub.address);
                        const maxAction = await db.getMaxActionIndex(config);
                        snapshotData = { channel: 'address', address: sub.address, balances: balances || [], last_action_index: maxAction || 0 };
                        break;
                    }
                    case 'token': {
                        const tokenInfo = await db.getTokenInfo(config, sub.tick);
                        snapshotData = { channel: 'token', tick: sub.tick, ...(tokenInfo || {}) };
                        break;
                    }
                    case 'market': {
                        const marketInfo = await db.getMarketInfo(config, sub.tick1, sub.tick2);
                        snapshotData = { channel: 'market', tick1: sub.tick1, tick2: sub.tick2, ...(marketInfo || {}) };
                        break;
                    }
                    case 'dispenser': {
                        const dispenserInfo = await db.getDispenserInfo(config, sub.action_index);
                        snapshotData = { channel: 'dispenser', action_index: sub.action_index, ...(dispenserInfo || {}) };
                        break;
                    }
                }

                if (snapshotData) {
                    this._send(client, {
                        type:      'SNAPSHOT',
                        chain:     client.chain,
                        network:   client.network,
                        timestamp: Date.now(),
                        data:      snapshotData
                    });
                }
            } catch (e) {
                // Non-fatal: skip this snapshot
                console.error('Snapshot error for', sub.channel, ':', e);
            }
        }
    }

    // Handle connection close
    _onClose(client) {
        this._log('disconnect', client.id, { coin: client.coin, subs: client.subscriptions.size });
        this.channelManager.removeClient(client);
        this.clients.delete(client.id);
        const ipCount = (this.ipCounts.get(client.ip) || 1) - 1;
        if (ipCount <= 0) this.ipCounts.delete(client.ip);
        else this.ipCounts.set(client.ip, ipCount);
    }

    // Handle connection error
    _onError(client, err) {
        if (err.code !== 'ECONNRESET') {
            console.log('WebSocket error for client', client.id, ':', err.message);
        }
    }

    // Structured logging for WebSocket events
    _log(event, clientId, details) {
        const ts = new Date().toISOString();
        const parts = ['[WS]', ts, event];
        if (clientId !== undefined) parts.push('client=' + clientId);
        if (details) {
            for (const [k, v] of Object.entries(details)) {
                parts.push(k + '=' + v);
            }
        }
        console.log(parts.join(' '));
    }

    // Send JSON message to a client
    _send(client, msg) {
        if (client.ws.readyState === 1) { // OPEN
            try {
                client.ws.send(safeStringify(msg));
            } catch (e) {
                // Connection may have closed between check and send
            }
        }
    }

    // Send error message
    _sendError(client, code, message, id) {
        const error = {
            type:      'error',
            timestamp: Date.now(),
            data:      { code, message }
        };
        if (id !== undefined) error.id = id;
        this._send(client, error);
    }

    // Periodic ping to detect dead connections
    _startPingInterval() {
        this.pingTimer = setInterval(() => {
            for (const [, client] of this.clients) {
                if (!client.alive) {
                    // Missed previous pong: terminate
                    client.ws.terminate();
                    continue;
                }
                client.alive = false;
                client.ws.ping();
            }
        }, this.pingInterval);

        // Idle timeout check: only disconnect clients with zero subscriptions
        this.idleTimer = setInterval(() => {
            const now = Date.now();
            for (const [, client] of this.clients) {
                if (client.subscriptions.size === 0 && (now - client.lastActivity) > this.idleTimeout) {
                    client.ws.close(4000, 'No subscriptions');
                }
            }
        }, this.idleTimeout);
    }

    // Resolve coin prefix to chain/network (e.g., "TBTC" -> { chain: "BTC", network: "testnet" })
    _resolveCoin(coinParam) {
        // Lazy-load valid coins from config
        if (!this.validCoins) {
            this._loadValidCoins();
        }
        return this.validCoins ? this.validCoins[coinParam] : null;
    }

    _loadValidCoins() {
        try {
            this.validCoins = {};
            // Build coin map from the known structure: BTC, LTC, DOGE + T/R prefixes
            const chains   = ['BTC', 'LTC', 'DOGE'];
            const prefixes = { '': 'mainnet', 'T': 'testnet', 'R': 'regtest' };

            for (const chain of chains) {
                for (const [prefix, network] of Object.entries(prefixes)) {
                    const coin = prefix + chain;
                    this.validCoins[coin] = { chain, network };
                }
            }
        } catch (e) {
            this.validCoins = null;
        }
    }
}

module.exports = WebSocketServer;
