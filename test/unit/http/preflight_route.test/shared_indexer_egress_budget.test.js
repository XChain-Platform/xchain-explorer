/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Every indexer call the explorer proxies leaves from the explorer's one
 * IP, so every client shares the indexer's single per-IP bucket. A client
 * inside every limit of its own must not be refused because other clients
 * drained that bucket: the explorer keeps an egress budget below the
 * indexer's ceiling and sheds the clients over their fair share locally,
 * before the indexer refuses whoever arrives last.
 */

'use strict';

const sinon = require('sinon');
const axios = require('axios');
const express = require('express');
const request = require('supertest');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');
const { methods: mounts } = require('../../../../src/explorer/mount.js');

const INDEXER_URL = 'http://indexer.test:1';
const UPSTREAM_LIMIT = 600;               // the indexer's default per-IP ceiling
const UPSTREAM_WINDOW_MS = 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
// The indexer's fixed window is not aligned with anything on the explorer's side.
const UPSTREAM_OFFSET_MS = 23 * 1000;

const resetBudgets = () => { if (typeof IndexerConnector.resetEgressBudgets === 'function') IndexerConnector.resetEgressBudgets(); };

// The indexer's per-IP bucket: every explorer call comes from one IP, so one bucket.
function upstreamBucket() {
    const bucket = { windows: new Map(), refused: 0 };
    bucket.post = async () => {
        const w = Math.floor((Date.now() - T0 - UPSTREAM_OFFSET_MS) / UPSTREAM_WINDOW_MS);
        const n = (bucket.windows.get(w) || 0) + 1;
        bucket.windows.set(w, n);
        if (n > UPSTREAM_LIMIT) {
            bucket.refused++;
            throw Object.assign(new Error('Request failed with status code 429'), {
                response: { status: 429, headers: { 'retry-after': '9' } },
            });
        }
        return { data: { jsonrpc: '2.0', id: 1, result: { valid: true } } };
    };
    bucket.peak = () => Math.max(0, ...bucket.windows.values());
    return bucket;
}

// The preflight routes mounted as mountRoutes mounts them, on an app that resolves
// the client from X-Forwarded-For the way production's trust-proxy setting does.
function preflightApp() {
    const app = express();
    app.set('trust proxy', 1);
    const host = {
        app,
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'ltc', network: 'regtest' }),
        util: { isNull: (v) => v === undefined || v === null || v === '' },
        processPreflightRequest: XChainExplorer.prototype.processPreflightRequest,
        processFeeQuoteRequest() {},
        processOracleFeeQuoteRequest() {},
    };
    mounts.mountFeeQuoteRoutes.call(host, {
        rateLimit: () => (req, res, next) => next(),
        limitedHandler: () => () => {},
        configEnv: () => ({}),
    });
    return app;
}

// Four clients at 170/min and one at 30/min (one every 2 s), all under the
// app-wide 180, for `seconds` of simulated time; 710/min offered upstream.
function schedule(seconds) {
    const events = [];
    const clients = [
        { ip: '198.18.7.10', perMin: 170 }, { ip: '198.18.7.11', perMin: 170 },
        { ip: '198.18.7.12', perMin: 170 }, { ip: '198.18.7.13', perMin: 170 },
        { ip: '198.18.7.50', perMin: 30 },
    ];
    for (const [i, c] of clients.entries()) {
        const gap = 60000 / c.perMin;
        for (let t = i * 7; t < seconds * 1000; t += gap) events.push({ t: Math.floor(t), ip: c.ip });
    }
    return events.sort((a, b) => a.t - b.t);
}

async function drive(app, seconds, distinctInputs) {
    const clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
    const results = new Map();   // ip -> { ok, shed, upstream, other, sent }
    const server = app.listen(0);
    try {
        let n = 0;
        for (const ev of schedule(seconds)) {
            clock.setSystemTime(T0 + ev.t);
            const source = distinctInputs ? 'mzSource' + (n++) : 'mzSource';
            const res = await request(server)
                .get('/RLTC/api/preflight')
                .query({ action: 'ISSUE', params: '0|SWPLSEVEN', source })
                .set('X-Forwarded-For', ev.ip);
            const r = results.get(ev.ip) || { ok: 0, shed: 0, upstream: 0, other: 0, sent: 0 };
            r.sent++;
            if (res.status === 200) r.ok++;
            else if (res.status === 429 && res.body.code === 'RATE_LIMITED') r.shed++;
            else if (res.status === 502 && res.body.code === 'UPSTREAM_ERROR') r.upstream++;
            else r.other++;
            results.set(ev.ip, r);
        }
    } finally {
        server.close();
        clock.restore();
    }
    return results;
}

describe('shared indexer egress budget: proxied preflight clients', function () {
    this.timeout(120000);

    let bucket;
    beforeEach(() => {
        resetBudgets();
        bucket = upstreamBucket();
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns(INDEXER_URL);
        sinon.stub(axios, 'post').callsFake(bucket.post);
    });
    afterEach(() => { sinon.restore(); resetBudgets(); });

    it('the indexer never refuses the explorer and no client gets an upstream 502', async function () {
        const results = await drive(preflightApp(), 180, true);
        // The load really was over the indexer's ceiling, and it really reached it.
        const sent = [...results.values()].reduce((a, r) => a + r.sent, 0);
        expect(sent).to.be.above(2000);
        expect([...bucket.windows.values()].reduce((a, n) => a + n, 0)).to.be.above(1200);
        expect(bucket.refused, 'indexer 429s reached the explorer').to.equal(0);
        expect(bucket.peak()).to.be.below(UPSTREAM_LIMIT);
        for (const [ip, r] of results) {
            expect(r.upstream, ip + ' got a 502 for an upstream refusal').to.equal(0);
            expect(r.other, ip + ' got an unexpected answer').to.equal(0);
        }
    });

    it('the light client keeps every request while the heavy clients drain the budget', async function () {
        const results = await drive(preflightApp(), 180, true);
        const light = results.get('198.18.7.50');
        expect(light.ok, 'light client refused').to.equal(light.sent);
        // The excess is shed, and only from the clients that use the most of the budget.
        let shed = 0;
        for (const ip of ['198.18.7.10', '198.18.7.11', '198.18.7.12', '198.18.7.13']) {
            const r = results.get(ip);
            shed += r.shed;
            expect(r.ok, ip + ' starved').to.be.above(200);
        }
        expect(shed).to.be.above(0);
    });

    it('a refusal names a usable Retry-After and is marked retryable', async function () {
        // Drain the budget from one client inside a fixed instant.
        const app = preflightApp();
        const clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
        const server = app.listen(0);
        try {
            let last = null;
            for (let i = 0; i < 700 && !(last && last.status === 429); i++)
                last = await request(server).get('/RLTC/api/preflight').query({ action: 'SEND', source: 'a' + i }).set('X-Forwarded-For', '198.18.7.20');
            expect(last.status).to.equal(429);
            expect(last.body).to.deep.equal({ error: 'Too many indexer-backed requests', code: 'RATE_LIMITED', retryable: true });
            expect(Number(last.headers['retry-after'])).to.be.within(1, 60);
            expect(bucket.refused).to.equal(0);
        } finally {
            server.close();
            clock.restore();
        }
    });
});

describe('shared indexer egress budget: connector', function () {
    beforeEach(() => resetBudgets());
    afterEach(() => { sinon.restore(); resetBudgets(); });

    it('caps calls per sliding window, whoever makes them, without reaching the indexer', async function () {
        const clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
        try {
            const post = sinon.stub(axios, 'post').resolves({ data: { result: 'ok' } });
            const c = new IndexerConnector(INDEXER_URL);
            let refused = null;
            let made = 0;
            for (let i = 0; i < UPSTREAM_LIMIT + 50; i++) {
                clock.setSystemTime(T0 + i * 10);
                try { await c.health(); made++; } catch (e) { refused = e; break; }
            }
            expect(refused, 'no cap below the indexer ceiling').to.not.equal(null);
            expect(refused.code).to.equal('INDEXER_RATE_LIMITED');
            expect(refused.retryAfter).to.be.within(1, 60);
            expect(made).to.be.below(UPSTREAM_LIMIT);
            expect(post.callCount).to.equal(made);
            // A minute after the first call the window has room again.
            clock.setSystemTime(T0 + UPSTREAM_WINDOW_MS + 1);
            await c.health();
            expect(post.callCount).to.equal(made + 1);
        } finally {
            clock.restore();
        }
    });

    it('a light client keeps its share when a heavy one drains the rest', async function () {
        const clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
        try {
            sinon.stub(axios, 'post').resolves({ data: { result: 'ok' } });
            const c = new IndexerConnector(INDEXER_URL);
            let heavyServed = 0;
            for (let i = 0; i < 2000; i++) {
                clock.setSystemTime(T0 + i * 20);
                if (!IndexerConnector.egressAdmit(INDEXER_URL, 'heavy').ok) continue;
                await IndexerConnector.withEgressClient('heavy', () => c.health());
                heavyServed++;
                if (i % 100 === 0) {
                    expect(IndexerConnector.egressAdmit(INDEXER_URL, 'light').ok, 'light client shed at step ' + i).to.equal(true);
                    await IndexerConnector.withEgressClient('light', () => c.health());
                }
            }
            expect(heavyServed).to.be.above(0);
            // Once the budget is under pressure the heavy client is the one held back.
            expect(IndexerConnector.egressAdmit(INDEXER_URL, 'heavy').ok).to.equal(false);
            expect(IndexerConnector.egressAdmit(INDEXER_URL, 'light').ok).to.equal(true);
        } finally {
            clock.restore();
        }
    });
});
