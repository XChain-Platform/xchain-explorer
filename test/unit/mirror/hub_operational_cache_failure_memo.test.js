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

// Outage cost of HubOperationalCache.getRows. With the hub down, one read pays
// the connector's whole retry window (two attempts plus backoff, about 2 s on
// an unreachable hub). A failed read is remembered for one TTL window and
// concurrent misses share one in-flight read, so a page request during an
// outage does not hold its request slot for that window before it gets the
// stale rows.
//
// The stubbed connector advances a fake clock by RETRY_MS on every call, so
// "no retry window was paid" reads as "the clock did not move".

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const quietObservability = require('../../helpers/quiet-observability.js');

const RETRY_MS = 2000;
const TTL_MS   = 15000;

// Load the cache over a fake connector whose call is `callStub`. `rpc.error`,
// when set, is written onto the call-scoped sink as a fleet-wide JSON-RPC answer.
function loadCache({ env = {} } = {}) {
    const callStub = sinon.stub();
    const rpc = { error: null };
    class FakeConnector {
        constructor(endpoints) { this.urls = endpoints; }
        call(data, opts) {
            if (opts && opts.out) {
                opts.out.rpcError = rpc.error;
                opts.out.allEndpointsAnswered = !!rpc.error;
                opts.out.failures = [];
            }
            return callStub(data, opts);
        }
    }
    FakeConnector.parseEndpoints = () => ['http://hub.test:10000'];
    const keys = ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS'];
    const saved = {};
    const wanted = Object.assign({ EXPLORER_HUB_CACHE_MS: String(TTL_MS), EXPLORER_HUB_CACHE_STALE_MAX_MS: '600000' }, env);
    for (const k of keys) {
        saved[k] = process.env[k];
        if (wanted[k] !== undefined) process.env[k] = wanted[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../../src/mirror/operational_cache.js', {
        '../connectors/hub': FakeConnector,
        '../observability': quietObservability
    });
    const cache = new HubOperationalCache({ util: new Utility(createConfigInfoStub()) });
    for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return { cache, callStub, rpc };
}

let clock = null;
function useClock() {
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1700000000000 }); });
    afterEach(function () { clock.restore(); sinon.restore(); });
}

// An unreachable hub: the call burns the retry window and returns null.
function goDown(callStub) {
    callStub.callsFake(async () => { clock.tick(RETRY_MS); return null; });
}

// Cache one row set, then let its TTL lapse while it stays inside the ceiling.
async function seedThenExpire(cache, callStub) {
    callStub.resolves([{ id: 'p1' }]);
    expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p1' }]);
    clock.tick(TTL_MS + 5000);
}

describe('HubOperationalCache: a hub outage is paid once per TTL window, not once per request', function () {
    useClock();

    it('serves warm stale rows at once on the request after a failed read', async function () {
        const { cache, callStub } = loadCache();
        await seedThenExpire(cache, callStub);
        goDown(callStub);

        expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p1' }]);
        expect(callStub.callCount).to.equal(2);

        const t0 = Date.now();
        for (let i = 0; i < 5; i++)
            expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p1' }]);
        expect(callStub.callCount, 'a repeat request inside the memo window called the hub again').to.equal(2);
        expect(Date.now() - t0, 'a repeat request paid the retry window').to.be.below(RETRY_MS);
    });

    it('answers null at once on a cold cache after a failed read', async function () {
        const { cache, callStub } = loadCache();
        goDown(callStub);
        expect(await cache.getRows('getvotes', { proposal_id: 'p' })).to.equal(null);
        const t0 = Date.now();
        expect(await cache.getRows('getvotes', { proposal_id: 'p' })).to.equal(null);
        expect(callStub.callCount).to.equal(1);
        expect(Date.now() - t0).to.equal(0);
    });

    it('still refuses rows past the stale ceiling inside the memo window', async function () {
        const { cache, callStub } = loadCache({ env: { EXPLORER_HUB_CACHE_STALE_MAX_MS: '30000' } });
        await seedThenExpire(cache, callStub);
        goDown(callStub);
        expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p1' }]);
        clock.tick(10000);
        expect(await cache.getRows('getproposals', {}), 'memo path served rows past the ceiling').to.equal(null);
        expect(callStub.callCount).to.equal(2);
    });
});

describe('HubOperationalCache: single-flight reads and the edges of the failure memo', function () {
    useClock();

    it('shares one in-flight read across concurrent misses on one key', async function () {
        const { cache, callStub } = loadCache();
        await seedThenExpire(cache, callStub);
        let release = null;
        const gate = new Promise(r => { release = r; });
        callStub.callsFake(() => gate);

        const all = Promise.all(Array.from({ length: 8 }, () => cache.getRows('getproposals', {})));
        await Promise.resolve();
        release(null);
        const rows = await all;
        expect(callStub.callCount, 'concurrent misses each made their own hub call').to.equal(2);
        for (const r of rows) expect(r).to.deep.equal([{ id: 'p1' }]);
    });

    it('calls the hub again once the memo window passes, and a success clears the memo', async function () {
        const { cache, callStub } = loadCache();
        await seedThenExpire(cache, callStub);
        goDown(callStub);
        await cache.getRows('getproposals', {});
        expect(callStub.callCount).to.equal(2);

        clock.tick(TTL_MS);
        callStub.resolves([{ id: 'p2' }]);
        expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p2' }]);
        expect(callStub.callCount).to.equal(3);

        // The fresh rows expire; the next read must reach the hub, not a leftover memo.
        clock.tick(TTL_MS + 1);
        callStub.resolves([{ id: 'p3' }]);
        expect(await cache.getRows('getproposals', {})).to.deep.equal([{ id: 'p3' }]);
        expect(callStub.callCount).to.equal(4);
    });

    it('never memoes a fleet-wide -32601 capability gap as an outage', async function () {
        const { cache, callStub, rpc } = loadCache();
        rpc.error = { code: -32601, message: 'Method not found' };
        callStub.resolves({ error: rpc.error });
        for (let i = 0; i < 2; i++) {
            let err = null;
            try { await cache.getRows('getslashproposals', {}); } catch (e) { err = e; }
            expect(err, 'a capability gap must throw on every request').to.be.an('error');
            expect(String(err.message)).to.contain('-32601');
        }
        expect(callStub.callCount).to.equal(2);
    });
});
