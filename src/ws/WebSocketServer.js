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
const { WS_SCHEMA_VERSION } = require('./schema-version.js');

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
        // Create a noServer WSS (we handle upgrade manually for path filtering).
        // maxPayload MUST be set here: ws copies it into each connection's Receiver
        // during handleUpgrade (websocket-server.js -> ws.setSocket), and the Receiver
        // is the only thing that reads it. Setting it on the WebSocket afterwards is
        // dead, which left the endpoint on the 100 MB library default.
        this.wss = new WSServer({ noServer: true, maxPayload: this.maxMessageSize });

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
            msgLastRefill:    Date.now(),
            catchUpInProgress: false,
            snapshotInProgress: false,
            backpressureSkips: 0
        };

        this.clients.set(clientId, client);
        this.ipCounts.set(clientInfo.ip, (this.ipCounts.get(clientInfo.ip) || 0) + 1);

        this._log('connect', clientId, { coin: clientInfo.coin, ip: clientInfo.ip });

        // Send WELCOME
        this._sendWelcome(client);

        // Wire up event handlers
        ws.on('message', (data) => this._onMessage(client, data));
        ws.on('close', ()      => this._onClose(client));
        ws.on('error', (err)   => this._onError(client, err));
        ws.on('pong', ()       => { client.alive = true; });
    }

    // Is this coin's indexed tip too old for the WS layer to answer a
    // current-state question about it?
    //
    // The HTTP path has refused to serve a frozen replica
    // (XChainExplorer.processRequest -> 503 COIN_DATA_STALE), but every WS
    // serving boundary skipped that gate, so a replica whose producer reports
    // replica_stale kept answering WELCOME/CATCH_UP/SNAPSHOT out of frozen
    // tables, stamped with a current `timestamp` and no marker.
    //
    // Reads through db.isCoinTipStale, which is per-coin, 15s-cached and already
    // fails closed on an unreadable tip, so calling it per emit costs no query.
    // A db without the method is a unit-test double, never the shipped Database:
    // fail OPEN there rather than throw inside a send path, mirroring the
    // `typeof this.db.checkReorgAndInvalidate === 'function'` probe ChangeDetector
    // uses for the same reason.
    async _isCoinTipStale(coin) {
        const db = this.explorer && this.explorer.db;
        if (!db || typeof db.isCoinTipStale !== 'function') return false;
        try { return await db.isCoinTipStale(coin); }
        catch (e) { return false; }
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

        // WELCOME is the handshake, so it is annotated rather than withheld: a
        // client that never receives it cannot subscribe, unsubscribe or read the
        // limits, which is a worse outage than a marked one. The two indices below
        // are frozen on a stale replica, and unmarked they read as the live chain
        // tip. `stale` is an ADDITIVE optional field, so it needs no
        // WS_SCHEMA_VERSION bump (ws/schema-version.js states the rule), and it
        // carries the same name and meaning as the `stale` map /status publishes
        // over HTTP. Chain DATA is a different question and does fail closed: see
        // _handleCatchUp and _sendSnapshots.
        const tipStale = await this._isCoinTipStale(client.coin);

        const welcome = {
            type:      'WELCOME',
            chain:     client.chain,
            network:   client.network,
            timestamp: Date.now(),
            data: {
                version:              this.explorer.version || '1.0.0',
                server_time:          Date.now(),
                // Chain indices ride as decimal STRINGS, the v2 wire contract
                // (ws/schema-version.js): every action_index/block_index on a v2
                // frame is a string, and these two arrive from the db getters as
                // Number, which safeStringify leaves as a JSON number. Emitting a
                // number here handed one connection two types for the same field
                // (WELCOME numeric, CATCH_UP_COMPLETE and NEW_ACTION string) and
                // would truncate above 2^53.
                latest_block_index:   String(latestBlockIndex),
                latest_action_index:  String(latestActionIndex),
                // True when the two indices above are a frozen replica's, not the
                // live chain tip; omitted (not false) when fresh so the frame is
                // byte-identical to the historical one on the healthy path.
                ...(tipStale ? { stale: true } : {}),
                limits: {
                    max_subscriptions:      this.channelManager.maxSubscriptions,
                    max_message_rate:       this.maxMsgPerSec,
                    max_message_size:       this.maxMessageSize,
                    max_connections_per_ip: this.maxPerIp
                },
                // Derived from ChannelManager.VALID_CHANNELS (the single authority
                // that actually validates params.channel) so this self-description
                // cannot silently under-advertise a subscribable channel again.
                channels: [...ChannelManager.VALID_CHANNELS],
                // Derived from ChannelManager.VALID_TYPES (the single authority that
                // actually validates params.types) so this self-description cannot
                // silently under-advertise a filterable type again.
                types: [...ChannelManager.VALID_TYPES],
                // 'statuses' is intentionally NOT advertised: the block-derived
                // actions feed (getActionsSince) never populates a per-action
                // status, so a statuses filter on the actions channel is a silent
                // no-op. Rather than imply a filter we can't honor there (the
                // per-type status joins are deferred), we drop it from the
                // advertised contract so clients cannot rely on it. The filter
                // mechanism still runs for events that do carry a status (e.g.
                // lifecycle/COINPAY frames); it is simply not advertised.
                // 'ticks' is omitted for the same reason: getActionsSince
                // selects no tick/give_tick/get_tick column, so Broadcaster's
                // `if (tick && ...)` check never fires on the actions channel, the
                // only channel ChannelManager.subscribe attaches a ticks filter to.
                features: ['snapshot', 'once', 'fields', 'batch', 'catch_up']
            }
        };

        this._send(client, welcome);
    }

    // Handle incoming client message
    _onMessage(client, data) {
        client.lastActivity = Date.now();

        // Rate limiting: sliding window via continuous decay (leaky bucket).
        // The count drains at maxMsgPerSec per second instead of resetting on a
        // 1s boundary, so a burst straddling a window edge cannot double the
        // effective rate the way the old tumbling reset allowed.
        const now     = Date.now();
        const elapsed = now - client.msgLastRefill;
        if (elapsed > 0) {
            client.msgCount = Math.max(0, client.msgCount - (elapsed / 1000) * this.maxMsgPerSec);
            client.msgLastRefill = now;
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

        // Defense-in-depth: the ws surface is unauthenticated, and a synchronous
        // throw from any action handler escapes to `ws.on('message', ...)` with no
        // uncaughtException handler installed, terminating the process (a single
        // frame becomes a crash-loop DoS). Individual handlers validate
        // their input, but wrap the whole dispatch so any residual synchronous
        // throw returns an error frame and is logged, rather than killing the node.
        try {
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
        } catch (err) {
            console.error('[ws] handler threw for action "' + msg.action + '":', err);
            this._sendError(client, 'INTERNAL_ERROR', 'Internal error handling message', msg.id);
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

        // Still accept a `statuses` filter (non-breaking: ChannelManager keeps
        // validating and storing it), but it is a no-op on every event this server
        // currently produces (action.status is a literal SQL NULL from db.js
        // getActionsSince, so Broadcaster._passesFilter's status check never fires).
        // Surface that as `ignored_filters` so a client that sent it can observe the
        // no-op instead of silently getting nothing. Same params object for the whole
        // subscribe() call, so this is constant across every confirmation below.
        // `ticks` joins it for the same reason: no action frame carries a
        // tick field, so the ticks check never fires either.
        const ignored = [];
        if (params.statuses) ignored.push('statuses');
        if (params.ticks)    ignored.push('ticks');
        const ignoredFilters = ignored.length ? ignored : null;

        // Send SUBSCRIBED confirmation for each entity subscribed
        for (const sub of result.subscribed) {
            // 'statuses' and 'ticks' are deliberately not echoed here as ACTIVE filters:
            // confirming either back would let a client rely on a no-op. See the WELCOME
            // features note and the matching omission in ChannelManager.getSubscriptionList
            // (SUBSCRIPTION_LIST). Both are surfaced separately via `ignored_filters`.
            const activeFilters = {
                types:    result.filter.types    ? [...result.filter.types]    : null,
                fields:   result.filter.fields   ? [...result.filter.fields]   : null,
                once:     result.filter.once
            };
            const confirmation = {
                type:      'SUBSCRIBED',
                timestamp: Date.now(),
                data: {
                    channel: sub.channel,
                    // `filters` is the canonical key, shared with SUBSCRIPTION_LIST so a
                    // client reads one key path across both frames. `active_filters` is a
                    // deprecated alias kept for existing consumers.
                    filters:        activeFilters,
                    active_filters: activeFilters
                }
            };
            if (ignoredFilters) confirmation.data.ignored_filters = ignoredFilters;
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
        // Reject a non-integer / negative since_action_index BEFORE the depth gate.
        // Number('abc')/Number({}) is NaN and `NaN > depth` is always false, so an
        // unguarded value silently bypasses CATCH_UP_TOO_OLD and reaches the SQL bind
        // param as NaN/Infinity. Anchor with the same non-negative-integer guard the
        // REST checkpoint-range handler uses (XChainExplorer.js) and reply INVALID_PARAMS.
        if (!/^[0-9]+$/.test(String(sinceActionIndex))) {
            this._sendError(client, 'INVALID_PARAMS', 'since_action_index must be a non-negative integer', requestId);
            return;
        }
        // BigInt, not Number: the client sends its cursor as the decimal string the v2
        // wire contract gave it, and Number() rounded it above 2^53 ("9007199254740995"
        // -> 9007199254740996), so the replay asked for rows AFTER an action the client
        // had never seen and skipped it silently. The regex above already
        // proved the value is a non-negative integer literal, so BigInt() cannot throw.
        const sinceBig = BigInt(sinceActionIndex);

        // Check if catch-up already in progress
        if (client.catchUpInProgress) {
            this._sendError(client, 'CATCH_UP_IN_PROGRESS', 'A catch-up request is already running', requestId);
            return;
        }

        const db     = this.explorer.db;
        const config = { coin: client.coin };

        // Fail closed on a frozen replica, matching the HTTP path's 503
        // COIN_DATA_STALE. A catch-up replays chain history the client is missing;
        // served from a stale replica it silently hands back a SHORT replay and a
        // CATCH_UP_COMPLETE whose latest_action_index the client then treats as
        // caught-up, so the gap never heals. Refused through the same error frame
        // and requestId the depth gate below uses, so no new frame type or schema
        // version is involved.
        if (await this._isCoinTipStale(client.coin)) {
            this._sendError(client, 'COIN_DATA_STALE',
                'Indexed data for this coin is stale beyond its maximum tip age; refusing to replay it as current.',
                requestId);
            return;
        }

        // Check depth: reject if too far behind
        try {
            // Both sides BigInt so the subtraction is exact and never mixes types;
            // getMaxActionIndex answers in BigInt, and BigInt() re-wraps a Number a
            // test double may return.
            const currentMax = BigInt(await db.getMaxActionIndex(config) || 0);
            if (currentMax - sinceBig > BigInt(this.catchUpMaxDepth)) {
                this._sendError(client, 'CATCH_UP_TOO_OLD',
                    `Requested action_index ${sinceBig} is more than ${this.catchUpMaxDepth} behind current (${currentMax}). Use REST API to backfill.`,
                    requestId);
                return;
            }
        } catch (e) {
            this._sendError(client, 'CATCH_UP_TOO_OLD', 'Unable to determine current state', requestId);
            return;
        }

        client.catchUpInProgress = true;

        try {
            const actions = await db.getActionsSince(config, sinceBig, this.catchUpMaxEvents);
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
                        status:       action.status        || null,
                        // Additive (spec M1.4), and it MUST be copied here. These
                        // rows come from the same getActionsSince the live feed
                        // uses, so the destinations are already on them; omitting
                        // the field would hand a reconnecting client a narrower
                        // NEW_ACTION than the live channel sends, which is the
                        // live-versus-replay shape divergence the retired singular
                        // `destination` was removed to prevent (see Broadcaster
                        // _onAction). Same array-or-empty guarantee as live.
                        destinations: Array.isArray(action.destinations) ? action.destinations : []
                    }
                };

                // Apply the same filter pipeline (types/statuses/ticks) and fields
                // projection the live Broadcaster path applies, so a reconnecting
                // client can't see a wider or unprojected shape during catch-up
                // than it would on the live channel.
                if (!this.broadcaster._passesFilter(filter, event, action)) continue;
                const msg = filter.fields ? this.broadcaster._applyFieldsProjection(event, filter.fields) : event;

                this._send(client, msg);
                eventsReplayed++;
            }

            // Determine latest action index from replayed events. Emit as a decimal STRING
            // to match the v2 wire contract (ws/schema-version.js:26-29): every other
            // action_index on WS v2 serializes as a string, and Number() here would both
            // break that type contract and lose precision above 2^53.
            const latestIdx = actions.length > 0
                ? String(actions[actions.length - 1].action_index)
                : String(sinceBig);

            // Send CATCH_UP_COMPLETE
            const complete = {
                type:      'CATCH_UP_COMPLETE',
                chain:     info.chain,
                network:   info.network,
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

        // Fail closed on a frozen replica, matching the HTTP path's 503
        // COIN_DATA_STALE. A SNAPSHOT is the WS answer to "what is the current
        // state of this address/token/market", and on a stale replica it answered
        // out of frozen tables stamped `timestamp: Date.now()` with no marker: a
        // balance the chain has since moved, presented as live.
        // Withheld, not annotated, because the HTTP read of the same rows is
        // already refused and a subscriber must not get a different answer for the
        // same question over a different transport. One error frame carries the
        // reason so the withholding is visible rather than an empty silence; the
        // client's live subscriptions stay attached, so emission resumes on its own
        // once isCoinTipStale clears.
        if (await this._isCoinTipStale(client.coin)) {
            this._sendError(client, 'COIN_DATA_STALE',
                'Indexed data for this coin is stale beyond its maximum tip age; refusing to snapshot it as current.');
            return;
        }

        for (const sub of subscribed) {
            try {
                let snapshotData = null;

                // Same v2 decimal-string contract as WELCOME above: these indices
                // come from the db getters as Number, and the live frame the
                // subscriber sees next carries the same field as a string, so a
                // snapshot that seeds state must not seed it with the other type.
                switch (sub.channel) {
                    case 'blocks': {
                        const maxBlock = await db.getMaxBlockIndex(config);
                        // One tip key across both frame families on this channel. The
                        // snapshot named the tip latest_block_index (matching WELCOME)
                        // while every live NEW_BLOCK on the same channel names it
                        // block_index (Broadcaster._onBlock), so a subscriber seeding
                        // from the snapshot read undefined off its first live frame.
                        // Both keys are emitted here rather than latest_block_index
                        // being added to NEW_BLOCK: a per-block frame is NOT the tip
                        // during a catch-up burst (ChangeDetector emits up to
                        // fetchLimit blocks per poll), so 'latest' would be false on
                        // every frame but the last.
                        const tip = String(maxBlock || 0);
                        snapshotData = { channel: 'blocks', latest_block_index: tip, block_index: tip };
                        break;
                    }
                    case 'network': {
                        const maxBlock  = await db.getMaxBlockIndex(config);
                        const maxAction = await db.getMaxActionIndex(config);
                        snapshotData = { channel: 'network', block_height: String(maxBlock || 0), total_actions: String(maxAction || 0) };
                        break;
                    }
                    case 'address': {
                        const balances = await db.getAddressBalances(config, sub.address);
                        const maxAction = await db.getMaxActionIndex(config);
                        snapshotData = { channel: 'address', address: sub.address, balances: balances || [], last_action_index: String(maxAction || 0) };
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
                    // bet_feed is action_index-keyed exactly like dispenser above
                    // (ChannelManager.ENTITY_CHANNELS). Without this case snapshotData
                    // stayed null and the guard below skipped the send, so a market
                    // page subscribing with snapshot:true got SUBSCRIBED, no initial
                    // pools/status, and no error saying why.
                    case 'bet_feed': {
                        const betFeedInfo = await db.getBetFeedInfo(config, sub.action_index);
                        snapshotData = { channel: 'bet_feed', action_index: sub.action_index, ...(betFeedInfo || {}) };
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

    // Send JSON message to a client. Every frame is stamped with the envelope
    // schema version (see ws/schema-version.js) so subscribers can gate their
    // parsing on payload-shape changes.
    _send(client, msg) {
        if (client.ws.readyState === 1) { // OPEN
            try {
                if (msg && typeof msg === 'object' && msg.schema_version === undefined)
                    msg.schema_version = WS_SCHEMA_VERSION;
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
