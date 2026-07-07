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
// governance_votes over hub JSON-RPC) and the RPC-first read path in db.js:
// TTL/stale cache behavior, endpoint resolution, filter param mapping, and JS
// paging parity with the SQL cursor semantics it replaces.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// Load HubOperationalCache with a stubbed connector class so no HTTP happens.
function loadCache({ callResult, env = {} } = {}) {
    const callStub = sinon.stub().resolves(callResult === undefined ? [] : callResult);
    class FakeConnector {
        constructor(endpoints) { this.urls = endpoints; this._call = callStub; }
    }
    FakeConnector.parseEndpoints = () =>
        ['1', 'true', 'yes'].includes(String(env.NO_HUB || '').toLowerCase())
            ? null : ['http://hub.test:10000'];

    const saved = {};
    for (const k of ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS']) {
        saved[k] = process.env[k];
        if (env[k] !== undefined) process.env[k] = env[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../src/HubOperationalCache.js', {
        './XChainHubConnector': FakeConnector
    });
    const cache = new HubOperationalCache({ util });
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return { cache, callStub };
}

describe('HubOperationalCache', function () {

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

    describe('getGovernanceProposals() proposal_id narrowing', function () {
        it('filters the bounded list client-side by proposal_id', async function () {
            const { cache } = loadCache({ callResult: [{ id: 1, proposal_id: 'a' }, { id: 2, proposal_id: 'b' }] });
            const rows = await cache.getGovernanceProposals({ proposal_id: 'b' });
            expect(rows).to.deep.equal([{ id: 2, proposal_id: 'b' }]);
        });
    });
});

describe('db.js RPC-first operational reads', function () {

    function makeDb(hubOperational) {
        return new Database({ configInfo, util, hubOperational });
    }

    function rows(n) {
        return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
    }

    function listConfig(method, overrides = {}) {
        return makeConfig({ type: 'explorer', data: { method, ...overrides } });
    }

    describe('_pageHubOperationalRows()', function () {
        it('default action: DESC order, LIMIT window, total = filtered count', function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { limit: 3 } });
            const [page, args, total] = db._pageHubOperationalRows(cfg, rows(10));
            expect(args).to.equal(null);
            expect(total).to.equal(10);
            expect(page.map(r => r.id)).to.deep.equal([10, 9, 8]);
        });

        it("action 'next': id < start window", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { limit: 3 }, offset: { action: 'next', start: 8, stop: null } });
            const [page, , total] = db._pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal([7, 6, 5]);
            expect(total).to.equal(10, 'total ignores the cursor window, matching the SQL count query');
        });

        it("action 'prev': id > start, ASC order (reversed downstream)", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { order: 'ASC', limit: 3 }, offset: { action: 'prev', start: 4, stop: null } });
            const [page] = db._pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal([5, 6, 7]);
        });

        it("action 'last': id <= start, ASC order", function () {
            const db  = makeDb(null);
            const cfg = listConfig('getGovernanceVotes', { sql: { order: 'ASC', limit: 3 }, offset: { action: 'last', start: 3, stop: null } });
            const [page] = db._pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal([1, 2, 3]);
        });

        it('api paging applies apiOffset slice', function () {
            const db  = makeDb(null);
            const cfg = makeConfig({ type: 'api', data: { method: 'getGovernanceVotes', sql: { limit: 3, apiOffset: 3 } } });
            const [page] = db._pageHubOperationalRows(cfg, rows(10));
            expect(page.map(r => r.id)).to.deep.equal([7, 6, 5]);
        });
    });

    describe('RPC-first dispatch with legacy fallback', function () {
        it('uses the RPC cache and maps the type filter to params', async function () {
            const ops = {
                enabled: () => true,
                getValidatorCapabilities: sinon.stub().resolves([{ id: 3, capability: 'price' }])
            };
            const db  = makeDb(ops);
            const cfg = listConfig('getValidatorCapabilities', { search: 'price', type: 'capability' });
            const [page, , total] = await db.getValidatorCapabilities(cfg);
            expect(ops.getValidatorCapabilities.firstCall.args[0]).to.deep.equal({
                capability: 'price', signing_pubkey: undefined
            });
            expect(total).to.equal(1);
            expect(page[0].id).to.equal(3);
        });

        it('falls back to the legacy co-located schema SQL when RPC returns null', async function () {
            const ops = { enabled: () => true, getGovernanceVotes: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
            const cfg = listConfig('getGovernanceVotes');
            const [query, , count] = await db.getGovernanceVotes(cfg);
            expect(query).to.contain('`XChain_Hub`.governance_votes');
            expect(count).to.contain('count(*)');
        });

        it('legacy path throws loud when neither RPC nor a co-located schema exists', async function () {
            const db  = makeDb({ enabled: () => false });
            db.checkpointDb = {};
            let err = null;
            try { await db.getGovernanceProposals(listConfig('getGovernanceProposals')); }
            catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('governance_proposals');
        });
    });
});
