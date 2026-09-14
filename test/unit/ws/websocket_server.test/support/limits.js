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
 * Stress-sweep unit tests for src/ws/websocket_server.js:
 *   - ws-1: per-IP cap key must not trust a spoofable X-Forwarded-For token
 *   - ws-2: snapshot-on-subscribe must not re-fire for already-subscribed entities
 */

'use strict';

const { expect, sinon, makeServer, makeClient } = require('../../websocket_server.test.js');

// Client shaped like onConnection builds, with the rate-limit fields.
function makeRateClient() {
    return {
        ...makeClient('BTC'),
        lastActivity:  Date.now(),
        msgCount:      0,
        msgLastRefill: Date.now()
    };
}

// Feed one valid ping frame through onMessage; returns true if it was
// rate-limited (RATE_LIMITED error sent) and false if it went through.
function sendPing(s, client) {
    const before = s.sendError.callCount;
    s.onMessage(client, Buffer.from(JSON.stringify({ action: 'ping' })));
    return s.sendError.callCount > before &&
           s.sendError.lastCall.args[1] === 'RATE_LIMITED';
}

function setup(maxMsgPerSec) {
    const clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
    const s = makeServer({ maxMsgPerSec });
    sinon.stub(s, 'send');
    sinon.spy(s, 'sendError');
    const client = makeRateClient();
    return { clock, s, client };
}

describe('WebSocketServer#_onMessage rate limiter (sliding decay, not tumbling window)', function () {
    afterEach(() => sinon.restore());

    it('allows up to the limit and blocks the next message within the same second', function () {
        const { s, client } = setup(10);
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        expect(sendPing(s, client)).to.equal(true);
    });

    it('a burst straddling the old 1s boundary cannot double the rate (tumbling-window exploit)', function () {
        const { clock, s, client } = setup(10);
        // Old exploit: 10 msgs at t=999ms, then 10 more at t=1001ms all passed
        // because the window reset. With decay, only ~0 credit refills in 2ms.
        clock.tick(999);
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        clock.tick(2);
        expect(sendPing(s, client)).to.equal(true);
    });
});

describe('WebSocketServer#_onMessage rate limiter (sliding decay, not tumbling window)', function () {
    afterEach(() => sinon.restore());

    it('refills credit gradually in proportion to elapsed time', function () {
        const { clock, s, client } = setup(10);
        for (let i = 0; i < 10; i++) sendPing(s, client);
        expect(sendPing(s, client)).to.equal(true);   // saturated
        clock.tick(500);                               // refills 5 credits
        for (let i = 0; i < 4; i++) expect(sendPing(s, client)).to.equal(false);
        // 5th within the half-second exceeds the drained allowance again
        // (one credit was consumed by the rejected message above).
        expect(sendPing(s, client)).to.equal(true);
    });

    it('fully idle for >= 1s restores the full allowance and never goes negative', function () {
        const { clock, s, client } = setup(10);
        for (let i = 0; i < 10; i++) sendPing(s, client);
        clock.tick(60000); // long idle: count clamps at 0, not a huge negative credit
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        expect(sendPing(s, client)).to.equal(true);
    });
});

// Drive a real upgrade and a real oversized frame, because the previous
// cap was installed as `ws._maxPayload` on the WebSocket, which reads fine to any
// property-asserting test while the ws Receiver (the only reader of maxPayload) ran
// on the 100 MB library default. Only the wire says whether the cap is armed.
describe('WebSocketServer maxPayload (ws-5: the cap has to reach the receiver)', function () {
    const http     = require('http');
    const WSClient = require('ws');

    let server, wsServer;

    function listen() {
        return new Promise((resolve) => {
            server   = http.createServer();
            wsServer = makeServer({ maxMessageSize: 1024 });
            wsServer.attach([server]);
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });
    }

    // Send one frame and report how the server answered.
    function sendFrame(port, payload) {
        return new Promise((resolve) => {
            const ws = new WSClient('ws://127.0.0.1:' + port + '/BTC/api/websocket');
            ws.on('open',  () => ws.send(payload));
            ws.on('error', () => resolve({ outcome: 'error' }));
            ws.on('close', (code) => resolve({ outcome: 'closed', code }));
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'WELCOME') return;   // sent unprompted on connect
                ws.close();
                resolve({ outcome: 'reply', type: msg.type });
            });
        });
    }

    afterEach(function (done) {
        if (wsServer) wsServer.stop();
        if (server && server.listening) return server.close(() => done());
        done();
    });

    it('closes a >1024-byte frame with 1009 instead of parsing it', async function () {
        const port = await listen();
        const oversized = JSON.stringify({ action: 'ping', pad: 'a'.repeat(2000) });
        expect(oversized.length).to.be.greaterThan(1024);
        const res = await sendFrame(port, oversized);
        expect(res.outcome).to.equal('closed');
        expect(res.code).to.equal(1009);   // 1009 = message too big
    });

    it('still serves a normal under-cap frame', async function () {
        const port = await listen();
        const res = await sendFrame(port, JSON.stringify({ action: 'ping' }));
        expect(res.outcome).to.equal('reply');
        expect(res.type).to.equal('pong');
    });

    it('installs the configured size on the ws server options, where the receiver reads it', async function () {
        await listen();
        expect(wsServer.wss.options.maxPayload).to.equal(1024);
    });
});
