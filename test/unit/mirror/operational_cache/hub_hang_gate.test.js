'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A HUNG hub (accepts the connection, never answers) costs each operational
// read two full timeouts plus backoff, about 12 s. Every getRows caller is an
// API request holding a slot of the global concurrency gate, so misses on
// DISTINCT cache keys, which share neither the per-key in-flight read nor the
// per-key failure memo, each held a slot for that whole window and a burst of
// them shed every unrelated DB-only route. The cache must bound hub reads
// process-wide: a hung hub gets a small fixed number of reads, and every other
// miss settles at once from the stale-or-null rule.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const quietObservability = require('../../../helpers/quiet-observability.js');

const HANG_MS = 12000;
const TTL_MS  = 15000;

// Load the cache over a fake connector whose call is `callStub`; no endpoint
// answers at the protocol layer, so a null result reads as an unreachable hub.
function loadCache() {
    const callStub = sinon.stub();
    class FakeConnector {
        constructor(endpoints) { this.urls = endpoints; }
        call(data, opts) {
            if (opts && opts.out) {
                opts.out.rpcError = null;
                opts.out.allEndpointsAnswered = false;
                opts.out.failures = [];
            }
            return callStub(data, opts);
        }
    }
    FakeConnector.parseEndpoints = () => ['http://hub.test:10000'];
    const keys = ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS'];
    const wanted = { EXPLORER_HUB_CACHE_MS: String(TTL_MS), EXPLORER_HUB_CACHE_STALE_MAX_MS: '600000' };
    const saved = {};
    for (const k of keys) {
        saved[k] = process.env[k];
        if (wanted[k] !== undefined) process.env[k] = wanted[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../../../src/mirror/operational_cache.js', {
        '../connectors/hub': FakeConnector,
        '../observability': quietObservability
    });
    const cache = new HubOperationalCache({ util: new Utility(createConfigInfoStub()) });
    for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return { cache, callStub };
}

// Start `n` getRows calls and track which have settled and with what.
function fire(cache, n, keyOf) {
    const state = { settled: 0, values: [] };
    const all = [];
    for (let i = 0; i < n; i++) {
        all.push(cache.getRows(keyOf(i).method, keyOf(i).params).then(v => {
            state.settled++;
            state.values.push(v);
            return v;
        }));
    }
    state.all = Promise.all(all);
    return state;
}

const distinctKey = i => ({ method: 'getproposals', params: { status: 'p' + i, limit: 500 } });

describe('HubOperationalCache: a hung hub never pins a request slot per distinct-key miss', function () {
    let clock;
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1700000000000 }); });
    afterEach(function () { clock.restore(); sinon.restore(); });

    it('250 distinct-key misses make a bounded number of hub reads and settle within the queue wait', async function () {
        const { cache, callStub } = loadCache();
        callStub.callsFake(() => new Promise(r => setTimeout(() => r(null), HANG_MS)));

        const burst = fire(cache, 250, distinctKey);
        await clock.tickAsync(1100);

        expect(callStub.callCount, 'one hub read per distinct key is the stampede').to.be.at.most(8);
        // Only the bounded running reads may still be waiting on the hang.
        expect(burst.settled, 'misses held their slot for the whole hub hang')
            .to.be.at.least(250 - callStub.callCount);
        // Cold keys with no cached rows fail loud (null), never block.
        expect(burst.values.every(v => v === null)).to.equal(true);

        // Misses arriving while the hub still hangs answer at once.
        const late = fire(cache, 50, i => distinctKey(1000 + i));
        await clock.tickAsync(1);
        expect(late.settled).to.equal(50);
        expect(callStub.callCount).to.be.at.most(8);

        await clock.tickAsync(HANG_MS);
        await burst.all;
        expect(callStub.callCount).to.be.at.most(8);
    });

    it('serves warmed stale rows at once instead of waiting out the hang', async function () {
        const { cache, callStub } = loadCache();
        callStub.resolves([{ proposal_id: 1 }]);
        expect(await cache.getRows('getproposals', { limit: 500 })).to.deep.equal([{ proposal_id: 1 }]);
        await clock.tickAsync(TTL_MS + 1);

        callStub.callsFake(() => new Promise(r => setTimeout(() => r(null), HANG_MS)));
        const stampede = fire(cache, 200, distinctKey);
        const warmed = fire(cache, 1, () => ({ method: 'getproposals', params: { limit: 500 } }));
        await clock.tickAsync(1100);
        expect(warmed.settled, 'the warmed route waited the full hang').to.equal(1);
        expect(warmed.values[0]).to.deep.equal([{ proposal_id: 1 }]);
        await clock.tickAsync(HANG_MS);
        await stampede.all;
    });
});

describe('HubOperationalCache: the process-wide hub read bound keeps single-flight and recovers', function () {
    let clock;
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1700000000000 }); });
    afterEach(function () { clock.restore(); sinon.restore(); });

    it('100 concurrent same-key misses share one hub read', async function () {
        const { cache, callStub } = loadCache();
        callStub.callsFake(() => new Promise(r => setTimeout(() => r([{ id: 1 }]), 50)));
        const same = fire(cache, 100, () => ({ method: 'getvotes', params: { limit: 500 } }));
        await clock.tickAsync(60);
        await same.all;
        expect(callStub.callCount).to.equal(1);
        expect(same.values.every(v => Array.isArray(v) && v.length === 1)).to.equal(true);
    });

    it('after the down latch window the next miss probes the hub again and reads its rows', async function () {
        const { cache, callStub } = loadCache();
        callStub.callsFake(() => new Promise(r => setTimeout(() => r(null), HANG_MS)));
        const first = fire(cache, 20, distinctKey);
        await clock.tickAsync(HANG_MS + 1);
        await first.all;
        const probes = callStub.callCount;

        // Inside the latch window a new key answers at once with no hub read.
        const latched = fire(cache, 1, i => distinctKey(500 + i));
        await clock.tickAsync(1);
        expect(latched.settled).to.equal(1);
        expect(callStub.callCount).to.equal(probes);

        await clock.tickAsync(TTL_MS);
        callStub.resetBehavior();
        callStub.resolves([{ proposal_id: 9 }]);
        const rows = await cache.getRows('getproposals', { status: 'fresh', limit: 500 });
        expect(rows).to.deep.equal([{ proposal_id: 9 }]);
        expect(callStub.callCount).to.equal(probes + 1);
    });

    it('a JSON-RPC error for one key does not latch the hub down for other keys', async function () {
        const { cache, callStub } = loadCache();
        callStub.callsFake((data, opts) => {
            if (data.params.status === 'bad') {
                opts.out.rpcError = { code: -32602, message: 'Invalid params' };
                return Promise.resolve({ error: 'Invalid params' });
            }
            return Promise.resolve([{ ok: true }]);
        });
        expect(await cache.getRows('getproposals', { status: 'bad' })).to.equal(null);
        expect(await cache.getRows('getproposals', { status: 'good' })).to.deep.equal([{ ok: true }]);
    });
});
