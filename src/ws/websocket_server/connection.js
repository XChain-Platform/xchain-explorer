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
 * XChain Explorer - WebSocket Server: connection lifecycle
 *
 * Everything between a raw HTTP upgrade and a closed socket: attaching to the
 * HTTP servers, validating the path, coin and per-IP cap before upgrading,
 * registering the client record, the ping/pong keepalive and idle sweep, and
 * the bookkeeping when a connection closes or errors.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so websocket_server.js can copy them onto WebSocketServer.prototype
 * verbatim. Nothing here is ever instantiated: `this` is the WebSocketServer
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

const { WebSocketServer: WSServer } = require('ws');
// Module-scope logger, not the server's own log() method (see websocket_server.js).
const { getLogger } = require('../../observability');
const log = getLogger();

// Regex to match /{COIN}/api/websocket path
const WS_PATH_REGEX = /^\/([A-Z]{1,5})\/api\/websocket$/i;

class WebSocketConnection {

    // Attach to HTTP and/or HTTPS servers
    attach(servers) {
        // Create a noServer WSS (we handle upgrade manually for path filtering).
        // maxPayload MUST be set here: ws copies it into each connection's Receiver
        // during handleUpgrade (websocket-server.js -> ws.setSocket), and the Receiver
        // is the only thing that reads it. Setting it on the WebSocket afterwards is
        // dead, which left the endpoint on the 100 MB library default.
        this.wss = new WSServer({ noServer: true, maxPayload: this.maxMessageSize });

        this.wss.on('connection', (ws, req, clientInfo) => {
            this.onConnection(ws, req, clientInfo);
        });

        // Attach upgrade handler to each server
        for (const server of servers) {
            server.on('upgrade', (req, socket, head) => {
                this.handleUpgrade(req, socket, head);
            });
        }

        // Start ping interval
        this.startPingInterval();

        log.info('WS_SERVER_ATTACHED', { path: '/{COIN}/api/websocket' });
    }

    // Resolve the client IP that keys the per-IP connection cap. The leftmost
    // X-Forwarded-For token is fully client-supplied (real proxies APPEND the observed
    // peer to the right), so keying on it let an attacker send a unique XFF per upgrade
    // and open unbounded connections. With trustProxyHops=N>0, take the entry N from the
    // right (the address the outermost trusted proxy inserted); otherwise, and whenever
    // XFF is absent or malformed, fall back to the unspoofable TCP peer address.
    clientIp(req) {
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
    handleUpgrade(req, socket, head) {
        const match = WS_PATH_REGEX.exec(req.url);
        if (!match) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        const coinParam = match[1].toUpperCase();
        const coinInfo  = this.resolveCoin(coinParam);
        if (!coinInfo) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        // Per-IP connection limit
        const ip = this.clientIp(req);
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
    onConnection(ws, req, clientInfo) {
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
            // Entities whose SNAPSHOT was deferred because a fan-out was already
            // running for this client; drained when that fan-out settles.
            pendingSnapshots:  [],
            // Frames dropped for backpressure, and when the last skip was logged.
            backpressureSkips:    0,
            backpressureLoggedAt: 0
        };

        this.clients.set(clientId, client);
        this.ipCounts.set(clientInfo.ip, (this.ipCounts.get(clientInfo.ip) || 0) + 1);

        this.log('connect', clientId, { coin: clientInfo.coin, ip: clientInfo.ip });

        // Send WELCOME
        this.sendWelcome(client);

        // Wire up event handlers
        ws.on('message', (data) => this.onMessage(client, data));
        ws.on('close', ()      => this.onClose(client));
        ws.on('error', (err)   => this.onError(client, err));
        ws.on('pong', ()       => { client.alive = true; });
    }

    // Handle connection close
    onClose(client) {
        this.log('disconnect', client.id, {
            coin: client.coin, subs: client.subscriptions.size,
            backpressure_skips: client.backpressureSkips || 0
        });
        this.channelManager.removeClient(client);
        this.clients.delete(client.id);
        const ipCount = (this.ipCounts.get(client.ip) || 1) - 1;
        if (ipCount <= 0) this.ipCounts.delete(client.ip);
        else this.ipCounts.set(client.ip, ipCount);
    }

    // Handle connection error
    onError(client, err) {
        if (err.code !== 'ECONNRESET') {
            log.warn('WS_CLIENT_SOCKET_ERROR', { client: client.id, err: err.message });
        }
    }

    // Periodic ping to detect dead connections
    startPingInterval() {
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
}

module.exports = WebSocketConnection.prototype;
