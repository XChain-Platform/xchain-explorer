/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// Regression test for the unbounded JSON-RPC batch fan-out.
//
// express-json-rpc-router runs every element of a batch array concurrently,
// while the per-IP rate limiter and the global concurrency gate both count an
// HTTP REQUEST as one. The 10 KB body ceiling holds roughly 200 call objects
// and the only exposed method, ping, draws a pooled DB connection, so a single
// request from a single IP could pin the pool without tripping either bound.
//
// This builds the real middleware chain out of THIS service's own dependency
// versions and COUNTS handler invocations, so the control case proves the
// amplification is real rather than asserting a status code against nothing.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');

const { resolveMaxBatch, makeRpcBatchGuard } = require('../../src/rpcBatchGuard.js');

const CAP = 20;

// Stands in for `ping`: the point is only that a dispatched element costs
// something, so the counter is what the DB pool draw would have been.
function buildApp(withGuard, counter) {
    const app = express();
    app.use(bodyParser.json());
    if (withGuard) app.use(makeRpcBatchGuard(CAP));
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({ methods: { ping: () => { counter.calls++; return 'pong'; } } }));
    app.use((err, req, res, next) => { res.status(500).json({ error: 'internal' }); }); // eslint-disable-line no-unused-vars
    return app;
}

async function post(app, body) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: res.status, text: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const batch = (n) => Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));

describe('JSON-RPC batch cap', function () {
    this.timeout(10000);

    it('reproduces the fan-out WITHOUT the guard (21 calls dispatch 21 handlers)', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(false, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 200, 'unguarded router should have served the oversize batch');
        assert.strictEqual(counter.calls, CAP + 1, 'every element should have reached a handler without the guard');
    });

    it('rejects an over-cap batch with 400 / -32600 and dispatches nothing', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 400);
        const body = JSON.parse(r.text);
        assert.strictEqual(body.error.code, -32600);
        assert.match(body.error.message, /Batch too large \(max 20 requests per call\)/);
        assert.strictEqual(counter.calls, 0, 'no handler may run once the batch is refused');
    });

    it('passes an at-cap batch through to the dispatcher', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(counter.calls, CAP);
        assert.strictEqual(JSON.parse(r.text).length, CAP);
    });

    it('leaves a single (non-array) call untouched', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), { jsonrpc: '2.0', id: 1, method: 'ping' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(JSON.parse(r.text).result, 'pong');
        assert.strictEqual(counter.calls, 1);
    });

    it('leaves a bodiless GET to the req.body shim (no 500, no 400)', async () => {
        const app = buildApp(true, { calls: 0 });
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            assert.notStrictEqual(res.status, 500, 'the batch guard must not disturb the bodiless-GET path');
            assert.notStrictEqual(res.status, 400);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    describe('resolveMaxBatch', () => {
        it('keeps the default for missing, unparseable and non-positive values', () => {
            for (const raw of [undefined, null, '', 'abc', '0', '-5'])
                assert.strictEqual(resolveMaxBatch(raw, 20), 20, `raw=${JSON.stringify(raw)}`);
        });
        it('takes an explicit positive override', () => {
            assert.strictEqual(resolveMaxBatch('50', 20), 50);
        });
    });

    it('src/api.js mounts the guard before the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const guardIdx = src.indexOf('makeRpcBatchGuard(');
        const routerIdx = src.indexOf('jsonRouter({');
        assert.notStrictEqual(guardIdx, -1, 'batch guard mount missing from src/api.js');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from src/api.js');
        assert.ok(guardIdx < routerIdx, 'the batch guard must be registered before the jsonRouter mount');
    });
});
