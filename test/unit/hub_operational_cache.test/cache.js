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

// Hub operational-state cache (validator_capabilities / governance_proposals /
// governance_votes over hub JSON-RPC) and the RPC-first read path in db/index.js:
// TTL/stale cache behavior, endpoint resolution, filter param mapping, and JS
// paging parity with the SQL cursor semantics it replaces.

const { sinon, expect, loadCache, serveAfterOutage, makeDb, rows, listConfig, makeRpcDispatchFixture, makeConfig } = require('./helpers.js');

describe("HubOperationalCache", function () {
    afterEach(function () { sinon.restore(); });

    describe('endpoint resolution', function () {
        it('HUB_API_URL takes precedence and normalizes bare hosts', function () {
            const { cache } = loadCache({ env: { HUB_API_URL: 'hub1:10000, http://hub2:10000' } });
            expect(cache.enabled()).to.equal(true);
            expect(cache.connector.urls).to.deep.equal(['http://hub1:10000', 'http://hub2:10000']);
        });

        it('falls back to parseEndpoints() discovery endpoints', function () {
            const { cache } = loadCache({});
            expect(cache.enabled()).to.equal(true);
            expect(cache.connector.urls).to.deep.equal(['http://hub.test:10000']);
        });

        it('disabled under NO_HUB with no HUB_API_URL', function () {
            const { cache } = loadCache({ env: { NO_HUB: '1' } });
            expect(cache.enabled()).to.equal(false);
        });
    });
});

describe("HubOperationalCache", function () {
    afterEach(function () { sinon.restore(); });

    describe('getRows() caching', function () {
        it('serves a fresh cache hit without a second RPC call', async function () {
            const { cache, callStub } = loadCache({ callResult: [{ id: 1 }] });
            const a = await cache.getRows('getvotes', { proposal_id: 'p' });
            const b = await cache.getRows('getvotes', { proposal_id: 'p' });
            expect(a).to.deep.equal([{ id: 1 }]);
            expect(b).to.deep.equal([{ id: 1 }]);
            expect(callStub.callCount).to.equal(1);
        });

        it('caches per distinct filter params', async function () {
            const { cache, callStub } = loadCache({ callResult: [] });
            await cache.getRows('getvotes', { proposal_id: 'p1' });
            await cache.getRows('getvotes', { proposal_id: 'p2' });
            expect(callStub.callCount).to.equal(2);
        });

        it('drops undefined params from the RPC call and cache key', async function () {
            const { cache, callStub } = loadCache({ callResult: [] });
            await cache.getRows('getvotes', { proposal_id: undefined, voter_pubkey: 'aa' });
            expect(callStub.firstCall.args[0].params).to.deep.equal({ voter_pubkey: 'aa' });
        });

        it('serves stale rows when the hub becomes unreachable', async function () {
            const clock = sinon.useFakeTimers();
            try {
                const { cache, callStub } = loadCache({ callResult: [{ id: 7 }], env: { EXPLORER_HUB_CACHE_MS: '1000' } });
                await cache.getRows('getproposals', {});
                callStub.resolves(null);
                clock.tick(5000);
                const rows = await cache.getRows('getproposals', {});
                expect(rows).to.deep.equal([{ id: 7 }]);
            } finally { clock.restore(); }
        });

        it('returns null once stale rows pass the staleness ceiling', async function () {
            const clock = sinon.useFakeTimers();
            try {
                const { cache, callStub } = loadCache({
                    callResult: [{ id: 7 }],
                    env: { EXPLORER_HUB_CACHE_MS: '1000', EXPLORER_HUB_CACHE_STALE_MAX_MS: '10000' }
                });
                await cache.getRows('getproposals', {});
                callStub.resolves(null);
                clock.tick(20000);
                expect(await cache.getRows('getproposals', {})).to.equal(null);
            } finally { clock.restore(); }
        });

        it('treats an {error} RPC body as a failure (stale-or-null path)', async function () {
            const { cache } = loadCache({ callResult: { error: 'governance not active' } });
            expect(await cache.getRows('getproposals', {})).to.equal(null);
        });
    });
});

describe("HubOperationalCache", function () {
    afterEach(function () { sinon.restore(); });

    describe('getRows() caching', function () {
        // The RPC is the slow part of getRows: on an unreachable hub it burns two
        // attempts and their timeouts before the stale bridge is even reached. Time
        // read BEFORE that await is the age the rows had when the request started,
        // and the ceiling has to be measured against the clock now.
        //
        // These two cases straddle the ceiling from either side using the SAME
        // elapsed-during-RPC window, so neither can pass by accident: one row set is
        // under the ceiling at request time and over it by the time the answer comes
        // back (the defect), the other is under it at both instants (the control).
        describe('the stale ceiling is measured after the RPC, not before it', function () {

            it('refuses rows that cross the ceiling DURING the failing RPC', async function () {
                // 599s old on entry, 611s old on exit, 600s ceiling. Reading the clock
                // before the await serves these rows; reading it after refuses them.
                const rows = await serveAfterOutage({ ceilingMs: 600000, ageMs: 599000, rpcMs: 12000 });
                expect(rows, 'rows past the stale ceiling must fail loud, not be served')
                    .to.equal(null);
            });

            it('still serves rows that are under the ceiling at both instants', async function () {
                // Same 12s RPC, 500s old: 512s on exit, still inside 600s. This is the
                // control - without it the test above would also pass against a getRows
                // that simply refused everything.
                const rows = await serveAfterOutage({ ceilingMs: 600000, ageMs: 500000, rpcMs: 12000 });
                expect(rows).to.deep.equal([{ id: 7 }]);
            });

            // The entry's `at` is a claim about how old its DATA is. The rows describe
            // hub state from the request onward, so they are stamped at request start;
            // stamping them at the response would credit them with the RPC's duration
            // of freshness they never had, which is the same overshoot from the other
            // end.
            it('stamps a fresh entry at request start, not at response', async function () {
                const clock = sinon.useFakeTimers();
                try {
                    const { cache, callStub } = loadCache({
                        env: { EXPLORER_HUB_CACHE_MS: '1000', EXPLORER_HUB_CACHE_STALE_MAX_MS: '10000' },
                    });
                    const t0 = Date.now();
                    callStub.callsFake(async () => { clock.tick(4000); return [{ id: 7 }]; });
                    await cache.getRows('getproposals', {});
                    const entry = cache._cache.get('getproposals|{}');
                    expect(entry.at).to.equal(t0);
                } finally { clock.restore(); }
            });
        });
    });
});

describe("HubOperationalCache", function () {
    afterEach(function () { sinon.restore(); });

    // A -32601 answer means the hub is UP but its build does not serve the
    // method: a capability gap, never an outage. It must name itself accurately
    // and stay out of both outage paths (stale-serving and the unreachable
    // diagnosis); every other failure keeps the outage path exactly as is.
    describe('getRows() -32601 method-unsupported answers', function () {
        it('throws a distinct method-unsupported error instead of returning null', async function () {
            const { cache } = loadCache({
                callResult: null,
                rpcError: { code: -32601, message: 'Method not found' }
            });
            let err = null;
            try { await cache.getRows('getslashproposals', {}); }
            catch (e) { err = e; }
            expect(err, 'a -32601 was degraded into the outage null').to.be.an('error');
            expect(err.message).to.contain('getslashproposals');
            expect(err.message).to.contain('-32601');
            expect(err.message).to.contain('not supported');
            expect(err.message).to.not.contain('unreachable');
        });

        it('does not serve stale cached rows over a -32601 answer', async function () {
            const clock = sinon.useFakeTimers();
            try {
                const { cache, callStub, rpc } = loadCache({
                    callResult: [{ id: 7 }],
                    env: { EXPLORER_HUB_CACHE_MS: '1000' }
                });
                await cache.getRows('getproposals', {});
                callStub.resolves(null);
                rpc.error = { code: -32601, message: 'Method not found' };
                clock.tick(5000);
                let err = null;
                try { await cache.getRows('getproposals', {}); }
                catch (e) { err = e; }
                expect(err, 'stale rows papered over a method-unsupported answer').to.be.an('error');
                expect(err.message).to.contain('-32601');
            } finally { clock.restore(); }
        });

        it('a non-32601 JSON-RPC error still takes the outage path unchanged', async function () {
            const { cache } = loadCache({
                callResult: null,
                rpcError: { code: -32000, message: 'internal error' }
            });
            expect(await cache.getRows('getproposals', {})).to.equal(null);
        });

        it('a fresh cache hit is still served without consulting the connector', async function () {
            const { cache, callStub, rpc } = loadCache({ callResult: [{ id: 1 }] });
            await cache.getRows('getvotes', { proposal_id: 'p' });
            rpc.error = { code: -32601, message: 'Method not found' };
            const rows = await cache.getRows('getvotes', { proposal_id: 'p' });
            expect(rows).to.deep.equal([{ id: 1 }]);
            expect(callStub.callCount).to.equal(1);
        });
    });
});

describe("HubOperationalCache", function () {
    afterEach(function () { sinon.restore(); });

    describe('getGovernanceProposals() proposal_id narrowing', function () {
        it('filters the bounded list client-side by proposal_id', async function () {
            const { cache } = loadCache({ callResult: [{ id: 1, proposal_id: 'a' }, { id: 2, proposal_id: 'b' }] });
            const rows = await cache.getGovernanceProposals({ proposal_id: 'b' });
            expect(rows).to.deep.equal([{ id: 2, proposal_id: 'b' }]);
        });
    });
});
