'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const quietObservability = require('../../../helpers/quiet-observability.js');

const TTL_MS = 15000;

function loadCache(){
    const callStub = sinon.stub().resolves([{ id: 'row' }]);
    class FakeConnector {
        call(data, opts){
            if(opts && opts.out){
                opts.out.rpcError = null;
                opts.out.allEndpointsAnswered = false;
                opts.out.failures = [];
            }
            return callStub(data, opts);
        }
    }
    FakeConnector.parseEndpoints = () => ['configured'];
    const saved = {
        ttl: process.env.EXPLORER_HUB_CACHE_MS,
        stale: process.env.EXPLORER_HUB_CACHE_STALE_MAX_MS
    };
    process.env.EXPLORER_HUB_CACHE_MS = String(TTL_MS);
    process.env.EXPLORER_HUB_CACHE_STALE_MAX_MS = '600000';
    const HubOperationalCache = proxyquire('../../../../src/mirror/operational_cache.js', {
        '../connectors/hub': FakeConnector,
        '../observability': quietObservability
    });
    const cache = new HubOperationalCache({ util: new Utility(createConfigInfoStub()) });
    if(saved.ttl === undefined) delete process.env.EXPLORER_HUB_CACHE_MS;
    else process.env.EXPLORER_HUB_CACHE_MS = saved.ttl;
    if(saved.stale === undefined) delete process.env.EXPLORER_HUB_CACHE_STALE_MAX_MS;
    else process.env.EXPLORER_HUB_CACHE_STALE_MAX_MS = saved.stale;
    return { cache, callStub };
}

describe('HubOperationalCache eviction order', function () {
    let clock;
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1700000000000 }); });
    afterEach(function () { clock.restore(); sinon.restore(); });

    it('keeps a refreshed shared key through the next eviction and outage', async function () {
        const { cache, callStub } = loadCache();
        const shared = 'getvalidatorcapabilities|{"limit":500}';
        const rows = await cache.getRows('getvalidatorcapabilities', { limit: 500 });
        for(let i = 0; i < 499; i++)
            await cache.getRows('getvalidatorcapabilities', { signing_pubkey: 'pk' + i, limit: 500 });
        expect(cache._cache.size).to.equal(500);

        clock.tick(TTL_MS + 1);
        expect(await cache.getRows('getvalidatorcapabilities', { limit: 500 })).to.deep.equal(rows);
        await cache.getRows('getvalidatorcapabilities', { signing_pubkey: 'pk-new', limit: 500 });
        expect(cache._cache.has(shared)).to.equal(true);
        expect(cache._cache.has('getvalidatorcapabilities|{"limit":500,"signing_pubkey":"pk0"}')).to.equal(false);

        callStub.resolves(null);
        clock.tick(TTL_MS + 1);
        expect(await cache.getRows('getvalidatorcapabilities', { limit: 500 })).to.deep.equal(rows);
    });
});
