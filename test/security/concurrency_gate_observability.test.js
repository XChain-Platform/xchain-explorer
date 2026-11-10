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
 * Security: a saturated concurrency gate stays observable
 *
 * The gate reports on itself through JSON-RPC ping (request_gate), and the
 * container healthcheck is that same ping. If the ping sits behind the cap,
 * both answer 429 exactly while the gate is full, which is the only time
 * in_flight and shed matter. A shed must also leave a log line, coalesced so a
 * stampede does not become its own log flood. These cases drive the production
 * mount (applyRateLimits) over real HTTP, one forged client IP per request so
 * the per-IP limiter never fires.
 *
 * Run: mocha test/security/concurrency_gate_observability.test.js --timeout 5000
 */

'use strict';

const { expect } = require('chai');
const express    = require('express');
const http       = require('http');
const { createConcurrencyGate } = require('../../src/http/concurrency_gate.js');
const { applyRateLimits }       = require('../../src/http/api_boot/rate_limits.js');
const serviceLog = require('../../src/observability').getLogger();

let openServers = [];

function listen(server){
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function send(server, path, ipSuffix, init){
    init = init || {};
    const headers = Object.assign({ 'X-Forwarded-For': '198.51.100.' + ipSuffix }, init.headers || {});
    return fetch('http://127.0.0.1:' + server.address().port + path, Object.assign({}, init, { headers }));
}

function rpc(server, method, ipSuffix){
    return send(server, '/', ipSuffix, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method })
    });
}

async function waitFor(predicate, label){
    const deadline = Date.now() + 2000;
    while(Date.now() < deadline){
        if(predicate()) return;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('timed out waiting for: ' + label);
}

// '/held' takes a slot and never answers, so the gate stays full until the
// server is torn down.
function mountHeld(app, holds){
    app.get('/held', (req, res) => { holds.push(res); });
}

/**
 * The production guards in front of a ping that reports the gate it sits
 * behind, the way the service's ping does. The global body parser mounts
 * after the guards, as in the service, so the ping exemption cannot lean on it.
 */
function buildProductionShape(limit){
    const app = express();
    app.set('trust proxy', 1);
    const gate = applyRateLimits(app, { env: { EXPLORER_MAX_CONCURRENT_REQUESTS: String(limit) } }, () => false);
    app.use(express.json({ limit: '10kb' }));
    const holds = [];
    mountHeld(app, holds);
    app.post('/', (req, res) => {
        const id = req.body && req.body.id;
        if(req.body && req.body.method === 'ping'){
            return res.json({ jsonrpc: '2.0', id, result: { status: 'success', request_gate: gate.getStats() } });
        }
        return res.json({ jsonrpc: '2.0', id, result: 'other' });
    });
    const server = http.createServer(app);
    openServers.push(server);
    return { gate, server, holds };
}

async function fillGate(server, gate, holds, limit){
    for(let i = 1; i <= limit; i++) send(server, '/held', i).catch(() => {});
    await waitFor(() => holds.length === limit && gate.getStats().in_flight === limit, 'gate to fill');
}

function closeOpenServers(){
    for(const server of openServers){
        // fetch keeps its sockets alive, so close() alone would hang.
        if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close();
    }
    openServers = [];
}

describe('Security: a saturated concurrency gate still answers ping', function () {

    afterEach(closeOpenServers);

    it('answers a JSON-RPC ping with request_gate stats while the gate is full', async function () {
        const LIMIT = 3;
        const { gate, server, holds } = buildProductionShape(LIMIT);
        await listen(server);
        await fillGate(server, gate, holds, LIMIT);

        // Another call on the same path is still shed, so the exemption is
        // the ping and not the whole dispatcher.
        const other = await rpc(server, 'getinfo', 50);
        expect(other.status).to.equal(429);
        expect((await other.json()).code).to.equal('SERVER_BUSY');

        const ping = await rpc(server, 'ping', 51);
        expect(ping.status).to.equal(200);
        const stats = (await ping.json()).result.request_gate;
        expect(stats.limit).to.equal(LIMIT);
        expect(stats.in_flight).to.equal(LIMIT);
        expect(stats.shed).to.be.at.least(1);
    });

    it('still sheds a batch of pings, which draws one pool connection per element', async function () {
        const { gate, server, holds } = buildProductionShape(1);
        await listen(server);
        await fillGate(server, gate, holds, 1);

        const batch = await send(server, '/', 60, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])
        });
        expect(batch.status).to.equal(429);
    });
});

describe('Security: a concurrency gate shed leaves a log line', function () {

    afterEach(closeOpenServers);

    it('writes one coalesced shed line for a burst, naming the knob and the shed count', async function () {
        const LIMIT = 2;
        const { gate, server, holds } = buildProductionShape(LIMIT);
        await listen(server);
        await fillGate(server, gate, holds, LIMIT);

        const lines = [];
        const original = serviceLog.warn;
        serviceLog.warn = (line) => { lines.push(String(line)); };
        try {
            for(let i = 0; i < 5; i++){
                const refused = await send(server, '/held', 100 + i);
                expect(refused.status).to.equal(429);
                expect((await refused.json()).code).to.equal('SERVER_BUSY');
            }
        } finally {
            serviceLog.warn = original;
        }

        expect(gate.getStats().shed).to.equal(5);
        expect(lines).to.have.length(1);
        expect(lines[0]).to.include('shed total 1');
        expect(lines[0]).to.include('in_flight ' + LIMIT);
        expect(lines[0]).to.include('EXPLORER_MAX_CONCURRENT_REQUESTS');
    });

    it('carries the coalesced count on the next window\'s line', async function () {
        let clock = 1000000;
        const lines = [];
        const gate = createConcurrencyGate({ limit: 1, log: (line) => lines.push(line), now: () => clock, logWindowMs: 60000 });
        const app = express();
        app.use(gate);
        const holds = [];
        mountHeld(app, holds);
        const server = http.createServer(app);
        openServers.push(server);
        await listen(server);
        await fillGate(server, gate, holds, 1);

        for(let i = 0; i < 5; i++) expect((await send(server, '/held', 10 + i)).status).to.equal(429);
        expect(lines).to.have.length(1);

        clock += 61000;
        expect((await send(server, '/held', 20)).status).to.equal(429);
        expect(lines).to.have.length(2);
        expect(lines[1]).to.include('5 requests shed in the last 61 s');
        expect(lines[1]).to.include('shed total 6');
    });
});
