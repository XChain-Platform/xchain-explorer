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
 * This file is the entry and keeps the constructor, shutdown, the stale-tip
 * probes and the send primitives every part calls. The rest of the class is
 * composed from parts under websocket_server/: connection.js (upgrade,
 * connect, close, keepalive), welcome.js (WELCOME and coin resolution),
 * subscriptions.js (inbound messages and subscribe/unsubscribe/list),
 * catch_up.js (since_action_index replay) and snapshots.js (the SNAPSHOT
 * fan-out). Each part's methods arrive on WebSocketServer.prototype through
 * mixinParts below, so every require of this path still gets one class with
 * the same methods.
 *
 ********************************************************************/

const ChannelManager = require('./channel_manager.js');
// BigInt-safe JSON serializer (shared with Broadcaster via serialize.js). send
// cannot use raw JSON.stringify, which throws on BigInt DB columns; under the
// swallowing try/catch that would silently drop every message carrying a raw DB row.
const { safeStringify } = require('./serialize.js');
const { WS_SCHEMA_VERSION } = require('./schema_version.js');
// One logger for the whole service. `log` here is the module-scope logger, not
// this class's own log() method: a class method is not a lexical binding, so
// every log.info/log.error below reaches the shipper, including the ones inside
// log() itself.
const { getLogger } = require('../observability');
const log = getLogger();

const connectionMethods   = require('./websocket_server/connection.js');
const welcomeMethods      = require('./websocket_server/welcome.js');
const subscriptionMethods = require('./websocket_server/subscriptions.js');
const catchUpMethods      = require('./websocket_server/catch_up.js');
const snapshotMethods     = require('./websocket_server/snapshots.js');

// Copies a part's methods onto the class prototype. Object.assign cannot do
// this: a class method is non-enumerable, so assign would copy nothing.
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the caller would run another part's method.
function mixinParts(target, ...sources) {
    for (const source of sources) {
        for (const name of Object.getOwnPropertyNames(source)) {
            if (name === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('WebSocketServer part collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

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
    async isCoinTipStale(coin) {
        const db = this.explorer && this.explorer.db;
        if (!db || typeof db.isCoinTipStale !== 'function') return false;
        try { return await db.isCoinTipStale(coin); }
        catch (e) { return false; }
    }

    // Whether a stale coin is refused on CATCH_UP / SNAPSHOT (an error frame)
    // rather than served with `stale: true` on every frame. Same opt-in as the
    // HTTP 503 (db.staleFailClosed), so a subscriber never gets a different
    // answer for the same question over a different transport.
    staleFailClosed() {
        const db = this.explorer && this.explorer.db;
        return !!(db && typeof db.staleFailClosed === 'function' && db.staleFailClosed());
    }

    // Structured logging for WebSocket events. The caller's event name is the
    // logger's msg, which is where the platform's event token lives, and the
    // client id and details become real fields instead of a k=v string a
    // consumer would have to re-parse. The hand-built timestamp and the [WS]
    // prefix are gone because the shipper stamps both.
    log(event, clientId, details) {
        const fields = { ...(details || {}) };
        if (clientId !== undefined) fields.client = clientId;
        log.info(event, fields);
    }

    // Send JSON message to a client. Every frame is stamped with the envelope
    // schema version (see ws/schema_version.js) so subscribers can gate their
    // parsing on payload-shape changes.
    send(client, msg) {
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
    sendError(client, code, message, id) {
        const error = {
            type:      'error',
            timestamp: Date.now(),
            data:      { code, message }
        };
        if (id !== undefined) error.id = id;
        this.send(client, error);
    }
}

mixinParts(WebSocketServer.prototype, connectionMethods, welcomeMethods,
    subscriptionMethods, catchUpMethods, snapshotMethods);

module.exports = WebSocketServer;
