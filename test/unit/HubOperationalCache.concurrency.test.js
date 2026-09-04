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

// Cross-call regression for HubOperationalCache.getRows. The explorer holds ONE
// XChainHubConnector for the whole process, so two operational reads in flight
// interleave across the await inside _call. getRows must not diagnose its failure
// from the connector-global lastRpcError, which meant a concurrent -32601 for
// some OTHER method made this call throw "the hub is reachable; upgrade it" and
// skip the within-ceiling stale-cache bridge.
//
// Drives the REAL connector with axios stubbed, not the suite's FakeConnector:
// the fake encodes the same last-call-wins shape the fix is about, so a test
// built on it could not have gone red.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const RPC_ERROR = { data: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } } };

// Load the real connector with a stubbed axios, then load the cache on top of it.
function loadCacheOnRealConnector(post, env = {}) {
    const XChainHubConnector = proxyquire('../../src/XChainHubConnector', { axios: { post } });
    const saved = {};
    for (const k of ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS', 'HUB_RETRY_DELAY_MS']) {
        saved[k] = process.env[k];
        if (env[k] !== undefined) process.env[k] = env[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../src/HubOperationalCache.js', {
        './XChainHubConnector': XChainHubConnector
    });
    const cache = new HubOperationalCache({ util: new Utility(createConfigInfoStub()) });
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return cache;
}

describe('HubOperationalCache: a concurrent -32601 does not hijack another call', function () {

    afterEach(function () { sinon.restore(); });

    it('the unreachable-method call still serves its within-ceiling stale rows', async function () {
        // Method X: the hub build does not serve it (-32601). Method Y: the hub
        // is simply unreachable for it. Only Y has stale rows to bridge with.
        let mode = 'seed';
        const post = (url, data) => {
            if (mode === 'seed') return Promise.resolve({ data: { result: [{ id: 'y1' }] } });
            if (data.method === 'methodX') return Promise.resolve(RPC_ERROR);
            return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        };
        const cache = loadCacheOnRealConnector(post, {
            HUB_API_URL: 'http://hub.test:10000',
            EXPLORER_HUB_CACHE_MS: '1',
            EXPLORER_HUB_CACHE_STALE_MAX_MS: '600000',
            HUB_RETRY_DELAY_MS: '0'
        });

        // Seed the Y entry, then let its TTL (1ms) lapse while it stays well
        // inside the stale ceiling.
        expect(await cache.getRows('methodY', {})).to.deep.equal([{ id: 'y1' }]);
        await new Promise(r => setTimeout(r, 5));
        mode = 'live';

        const [x, y] = await Promise.allSettled([
            cache.getRows('methodX', {}),
            cache.getRows('methodY', {})
        ]);

        // X is the genuine capability gap and must still be diagnosed as one.
        expect(x.status).to.equal('rejected');
        expect(String(x.reason.message)).to.contain('-32601');

        // Y must not inherit X's answer: it is an outage, so the stale bridge serves.
        expect(y.status, y.status === 'rejected' ? String(y.reason && y.reason.message) : '').to.equal('fulfilled');
        expect(y.value).to.deep.equal([{ id: 'y1' }]);
    });

    it('_call keeps each invocation\'s answer on its own sink while the instance field churns', async function () {
        // The connector half of the same property, at the level the cache depends
        // on: two overlapping _call invocations each get their OWN rpcError, and
        // the last-call-wins instance field (which _call also clears on entry) can
        // no longer speak for either of them.
        let release = null;
        const gate = new Promise(r => { release = r; });
        const post = (url, data) => {
            if (data.method === 'methodX') return gate.then(() => RPC_ERROR);
            return Promise.resolve({ data: { result: [{ id: 'ok' }] } });
        };
        const XChainHubConnector = proxyquire('../../src/XChainHubConnector', { axios: { post } });
        const c = new XChainHubConnector(['http://hub.test:10000']);

        const outX = {}, outZ = {};
        const xPromise = c._call({ jsonrpc: '2.0', method: 'methodX', id: 1 }, { attempts: 1, out: outX });
        await c._call({ jsonrpc: '2.0', method: 'methodZ', id: 1 }, { attempts: 1, out: outZ });
        release();
        await xPromise;

        expect(outX.rpcError, 'the -32601 call keeps its own answer').to.deep.equal({ code: -32601, message: 'Method not found' });
        expect(outZ.rpcError, 'the healthy call records no error of its own').to.equal(null);
    });
});
