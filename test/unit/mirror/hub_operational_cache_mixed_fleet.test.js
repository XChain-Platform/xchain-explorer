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

// Mixed-version fleet regression for HubOperationalCache.getRows: an old hub's
// -32601 must not be read as a fleet-wide capability gap while the upgraded hub
// that serves the method is unreachable or degraded. Drives the REAL connector.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');

const OLD = 'http://a.test:10000';
const NEW = 'http://b.test:10000';
const RPC_ERROR = { data: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } } };
const REFUSED = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
const DEGRADED = () => Object.assign(new Error('Request failed with status code 503'),
    { response: { status: 503, data: { result: { status: 'degraded' } } } });

// Load the real connector with a stubbed axios, then load the cache on top of it.
function loadFleetCache(post) {
    const XChainHubConnector = proxyquire('../../../src/connectors/hub', { axios: { post } });
    const env = { HUB_API_URL: OLD + ',' + NEW, EXPLORER_HUB_CACHE_MS: '1',
        EXPLORER_HUB_CACHE_STALE_MAX_MS: '600000', HUB_RETRY_DELAY_MS: '0' };
    const saved = {};
    for (const k of ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS', 'HUB_RETRY_DELAY_MS']) {
        saved[k] = process.env[k];
        if (env[k] !== undefined) process.env[k] = env[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../../src/mirror/operational_cache.js', {
        '../connectors/hub': XChainHubConnector
    });
    const cache = new HubOperationalCache({ util: new Utility(createConfigInfoStub()) });
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return { cache, XChainHubConnector };
}

// A fleet whose old hub answers -32601 and whose new hub fails with `newFails` once live.
function fleet(newFails) {
    const state = { mode: 'seed' };
    state.post = (url) => {
        if (url === OLD) return Promise.resolve(RPC_ERROR);
        if (state.mode === 'seed') return Promise.resolve({ data: { result: [{ id: 'v1' }] } });
        return Promise.reject(newFails());
    };
    return state;
}

// Seed the entry from the new hub, then age it by `ageMs` and take the new hub down.
async function seedAndAge(cache, state, ageMs) {
    expect(await cache.getRows('getvotes', {})).to.deep.equal([{ id: 'v1' }]);
    expect(cache._cache.size, 'nothing was cached, so the stale bridge could not be exercised').to.be.above(0);
    for (const hit of cache._cache.values()) hit.at -= ageMs;
    state.mode = 'live';
}

describe('HubOperationalCache: mixed-version fleet with the upgraded hub down', function () {
    afterEach(function () { sinon.restore(); });

    it('serves within-ceiling stale rows when the old hub answers -32601 and the new hub is unreachable', async function () {
        const state = fleet(REFUSED);
        const { cache } = loadFleetCache(state.post);
        await seedAndAge(cache, state, 60000);
        expect(await cache.getRows('getvotes', {})).to.deep.equal([{ id: 'v1' }]);
    });

    it('serves within-ceiling stale rows when the old hub answers -32601 and the new hub is degraded', async function () {
        const state = fleet(DEGRADED);
        const { cache } = loadFleetCache(state.post);
        await seedAndAge(cache, state, 60000);
        expect(await cache.getRows('getvotes', {})).to.deep.equal([{ id: 'v1' }]);
    });

    it('returns null past the stale ceiling instead of a capability-gap error', async function () {
        const state = fleet(REFUSED);
        const { cache } = loadFleetCache(state.post);
        await seedAndAge(cache, state, 700000);
        expect(await cache.getRows('getvotes', {})).to.equal(null);
    });

    it('returns null with no cached entry when only part of the fleet answered -32601', async function () {
        const state = fleet(REFUSED);
        state.mode = 'live';
        const { cache } = loadFleetCache(state.post);
        expect(await cache.getRows('getvotes', {})).to.equal(null);
    });

    it('still throws the capability-gap error when every endpoint answers -32601', async function () {
        const { cache } = loadFleetCache(() => Promise.resolve(RPC_ERROR));
        let err = null;
        try { await cache.getRows('getvotes', {}); } catch (e) { err = e; }
        expect(err, 'a fleet-wide -32601 must still be diagnosed as a capability gap').to.be.an('error');
        expect(err.message).to.contain('-32601').and.to.contain('not supported');
    });

    it('the connector flags allEndpointsAnswered only when every endpoint gave a protocol answer', async function () {
        const { XChainHubConnector } = loadFleetCache(() => Promise.resolve(RPC_ERROR));
        const all = {};
        await new XChainHubConnector([OLD, NEW]).call({ jsonrpc: '2.0', method: 'm', id: 1 }, { attempts: 2, delayMs: 0, out: all });
        expect(all.allEndpointsAnswered).to.equal(true);

        const mixed = fleet(REFUSED);
        mixed.mode = 'live';
        const { XChainHubConnector: Mixed } = loadFleetCache(mixed.post);
        const part = {};
        await new Mixed([OLD, NEW]).call({ jsonrpc: '2.0', method: 'm', id: 1 }, { attempts: 2, delayMs: 0, out: part });
        expect(part.rpcError).to.deep.equal({ code: -32601, message: 'Method not found' });
        expect(part.allEndpointsAnswered).to.equal(false);
    });
});
