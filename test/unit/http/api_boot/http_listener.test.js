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
 * The HTTP listener cuts a request body that never finishes
 *
 * Clients that open sockets and trickle a body must not hold concurrency
 * gate slots for Node's 300 s default; an unrelated GET keeps answering.
 *
 * Run: mocha test/unit/http/api_boot/http_listener.test.js --timeout 20000
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const http       = require('http');
const net        = require('net');

const { startHttpListener, resolveRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS } =
    require('../../../../src/http/api_boot/http_listener.js');
const { createConcurrencyGate } = require('../../../../src/http/concurrency_gate.js');

const quietLog = { info(){}, warn(){}, error(){} };

function get(port){
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/ping', agent: false }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('http_listener slow request bodies', function(){
    this.timeout(20000);

    it('defaults to a finite timeout well under 300 s and ignores bad overrides', function(){
        expect(DEFAULT_REQUEST_TIMEOUT_MS).to.be.below(60001);
        expect(resolveRequestTimeoutMs(undefined)).to.equal(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(resolveRequestTimeoutMs('abc')).to.equal(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(resolveRequestTimeoutMs('0')).to.equal(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(resolveRequestTimeoutMs('400')).to.equal(400);
    });

    it('frees gate slots held by never-finishing bodies', async function(){
        const prior = process.env.EXPLORER_REQUEST_TIMEOUT_MS;
        process.env.EXPLORER_REQUEST_TIMEOUT_MS = '400';
        const gate = createConcurrencyGate({ limit: 2 });
        const app = express();
        app.use(gate);
        app.get('/ping', (req, res) => res.json({ ok: true }));
        app.post('/', (req, res) => req.on('data', () => {}).on('end', () => res.json({})));
        const runtime = {};
        const server = startHttpListener(app, runtime, 0, '127.0.0.1', quietLog);
        const socks = [];
        try {
            await new Promise((r) => server.once('listening', r));
            const port = server.address().port;
            expect(server.requestTimeout).to.equal(400);

            for(let i = 0; i < 2; i++){
                const s = net.connect(port, '127.0.0.1');
                s.on('error', () => {});
                s.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 8000\r\n\r\n{');
                socks.push(s);
            }
            await sleep(100);
            expect(gate.getStats().in_flight).to.equal(2);
            expect(await get(port)).to.equal(429);

            const deadline = Date.now() + 5000;
            while(gate.getStats().in_flight > 0 && Date.now() < deadline) await sleep(50);
            expect(gate.getStats().in_flight).to.equal(0);
            expect(await get(port)).to.equal(200);
        } finally {
            if(prior === undefined) delete process.env.EXPLORER_REQUEST_TIMEOUT_MS;
            else process.env.EXPLORER_REQUEST_TIMEOUT_MS = prior;
            socks.forEach((s) => s.destroy());
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });
});
