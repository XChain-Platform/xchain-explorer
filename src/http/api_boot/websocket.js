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
 * XChain Explorer - the live feed
 *
 * The last boot step of src/api.js, taken once the explorer's pools exist:
 * the socket server, the poller that watches the database and the broadcaster
 * that joins them. Feature-flagged off with WS_ENABLED=false.
 *
 ********************************************************************/

'use strict';

const WebSocketServer = require('../../ws/websocket_server.js');
const ChangeDetector  = require('../../ws/change_detector.js');
const Broadcaster     = require('../../ws/broadcaster.js');

/**
 * Every knob the live feed reads, resolved once.
 *
 * @param {object} configInfo src/config.js, for its live env view
 * @returns {object} the poll, ping, idle, per-IP, backpressure and subscription limits
 */
function wsSettings(configInfo){
    return {
        WS_POLL_INTERVAL: parseInt(configInfo.env.WS_POLL_INTERVAL) || 5000,
        WS_PING_INTERVAL: parseInt(configInfo.env.WS_PING_INTERVAL) || 30000,
        WS_IDLE_TIMEOUT:  parseInt(configInfo.env.WS_IDLE_TIMEOUT)  || 300000,
        WS_MAX_PER_IP:    parseInt(configInfo.env.WS_MAX_CONNECTIONS_PER_IP) || 5,
        WS_MAX_BACKPRESSURE: parseInt(configInfo.env.WS_MAX_BACKPRESSURE) || 65536,
        WS_MAX_SUBS: parseInt(configInfo.env.WS_MAX_SUBSCRIPTIONS) || 25,
        // Mirror the HTTP side's `trust proxy: 1` (src/http/trust_proxy.js) so the WS
        // per-IP cap keys on the real client address, not a spoofable
        // X-Forwarded-For token. The upgrade is handled on the raw HTTP server,
        // where Express trust-proxy does not apply, so the hop count must be
        // passed through explicitly.
        WS_TRUST_PROXY_HOPS: parseInt(configInfo.env.WS_TRUST_PROXY_HOPS, 10) || 1
    };
}

/**
 * WebSocket support (feature-flagged via WS_ENABLED env var).
 *
 * @param {object} deps configInfo, explorer, the two listeners and the runtime
 *        the shutdown drain reads
 */
function startWebsockets(deps){
    const { configInfo, explorer, httpServer, httpsServer, runtime } = deps;

    const WS_ENABLED = configInfo.env.WS_ENABLED !== 'false';
    if (!WS_ENABLED)
        return;

    const ws = wsSettings(configInfo);

    // Built first because the ChannelManager the pieces below need lives inside it.
    const wsServer = new WebSocketServer({
        explorer:         explorer,
        broadcaster:      null, // set below
        pingInterval:     ws.WS_PING_INTERVAL,
        idleTimeout:      ws.WS_IDLE_TIMEOUT,
        maxPerIp:         ws.WS_MAX_PER_IP,
        maxSubscriptions: ws.WS_MAX_SUBS,
        trustProxyHops:   ws.WS_TRUST_PROXY_HOPS
    });

    // Polls the database for new data and hands what changed to that channel manager.
    const changeDetector = new ChangeDetector({
        db:             explorer.db,
        channelManager: wsServer.channelManager,
        pollInterval:   ws.WS_POLL_INTERVAL
    });

    // Joins the two: detector events out to the sockets subscribed to them.
    const broadcaster = new Broadcaster({
        wsServer:        wsServer,
        changeDetector:  changeDetector,
        maxBackpressure: ws.WS_MAX_BACKPRESSURE
    });
    wsServer.broadcaster = broadcaster;

    // Take the WebSocket upgrade on HTTP, and on HTTPS when that listener is up.
    wsServer.attach(httpsServer ? [httpServer, httpsServer] : [httpServer]);

    // Poll only the coins that actually have a database pool behind them.
    const availableCoins = Object.keys(explorer.db.pools || {});
    if (availableCoins.length > 0) {
        changeDetector.start(availableCoins);
    }

    // Handed to the drain so subscribers get a clean 1001 close and the live-feed
    // poll timer stops, instead of both dying with the process.
    runtime.wsServer       = wsServer;
    runtime.changeDetector = changeDetector;
}

module.exports = { startWebsockets };
