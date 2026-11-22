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
 * stop() must not let a client that ignores the close frame hold the HTTP
 * listener open past the shutdown drain budget. The client here is a raw TCP
 * socket, because a ws client answers close frames on its own.
 *
 ********************************************************************/

'use strict';

const http            = require('http');
const net             = require('net');
const { expect }      = require('chai');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');
const { closeServer } = require('../../../../src/http/shutdown.js');

function listen(wsServer) {
    return new Promise((resolve) => {
        const server = http.createServer();
        wsServer.attach([server]);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// Upgrade by hand and then go silent: the socket is read but never answered.
function connectSilentClient(port) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = '';
        sock.on('error', () => {});
        sock.on('connect', () => {
            sock.write('GET /BTC/api/websocket HTTP/1.1\r\n' +
                'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        });
        sock.on('data', (d) => {
            buf += d.toString('latin1');
            if (buf.includes('101')) resolve(sock);
            else if (buf.includes('\r\n\r\n')) reject(new Error('upgrade refused'));
        });
    });
}

function waitFor(predicate, ms) {
    const end = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() > end) return reject(new Error('timed out'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

describe('WebSocketServer#stop with a client that never answers the close frame', function () {
    this.timeout(10000);

    it('lets the HTTP listener close within the grace period instead of the 30 s close timeout', async function () {
        const wsServer = new WebSocketServer({
            explorer: { db: {} }, broadcaster: null, closeGraceMs: 50
        });
        const server = await listen(wsServer);
        const sock = await connectSilentClient(server.address().port);
        await waitFor(() => wsServer.clients.size === 1, 2000);

        const started = Date.now();
        wsServer.stop();
        await closeServer(server);
        const elapsed = Date.now() - started;

        expect(elapsed).to.be.lessThan(3000);
        await waitFor(() => wsServer.clients.size === 0, 2000);
        sock.destroy();
    });

    it('defaults the grace well under the 8 s drain budget', function () {
        const wsServer = new WebSocketServer({ explorer: { db: {} }, broadcaster: null });
        expect(wsServer.closeGraceMs).to.be.within(1, 4000);
    });

    it('terminates a client still open when the grace ends', async function () {
        const wsServer = new WebSocketServer({
            explorer: { db: {} }, broadcaster: null, closeGraceMs: 30
        });
        const terminated = [];
        wsServer.wss = { close() {} };
        wsServer.clients.set(1, { ws: {
            close() {}, readyState: 2, terminate() { terminated.push(1); }
        } });
        wsServer.stop();
        await new Promise((r) => setTimeout(r, 80));
        expect(terminated).to.deep.equal([1]);
    });

    it('does not terminate a client that closed cleanly inside the grace', async function () {
        const wsServer = new WebSocketServer({
            explorer: { db: {} }, broadcaster: null, closeGraceMs: 30
        });
        const terminated = [];
        wsServer.wss = { close() {} };
        wsServer.clients.set(1, { ws: {
            close() {}, readyState: 3, terminate() { terminated.push(1); }
        } });
        wsServer.stop();
        await new Promise((r) => setTimeout(r, 80));
        expect(terminated).to.deep.equal([]);
    });
});
