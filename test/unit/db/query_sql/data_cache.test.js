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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const {
    RESULT_CACHES,
    resultCacheLookup,
    resultCacheStore
} = require('../../../../src/db/query_sql/data_cache.js');

function makeDb() {
    return {
        configInfo: { env: { EXPLORER_TOKENS_CACHE_MS: '1000' } },
        _reorgGen: { BTC: 0 },
        resultCacheGeneration: sinon.stub().resolves(100)
    };
}

function makeConfig(search) {
    return {
        coin: 'BTC',
        type: 'api',
        data: { method: 'getTokens', type: 'token', search, query: { page: 1 } }
    };
}

async function readThrough(db, config, compute) {
    const lookup = await resultCacheLookup(db, config);
    if(lookup.hit)
        return lookup.hit;
    const [data, total] = await compute();
    resultCacheStore(db, config, lookup.cacheName, lookup.cacheKey, data, total);
    return [data, total];
}

describe('data cache', function(){
    beforeEach(function(){
        sinon.useFakeTimers({ now: 1000, toFake: ['Date'] });
    });

    afterEach(function(){
        sinon.restore();
    });

    it('computes and stores a cache miss', async function(){
        const db = makeDb();
        const compute = sinon.stub().resolves([[{ tick: 'AAA' }], 1]);
        const result = await readThrough(db, makeConfig('AAA'), compute);

        assert.deepStrictEqual(RESULT_CACHES, {
            getHolders:  ['_holdersCache', 'EXPLORER_HOLDERS_CACHE'],
            getTokens:   ['_tokensCache', 'EXPLORER_TOKENS_CACHE'],
            getBalances: ['_balancesCache', 'EXPLORER_BALANCES_CACHE']
        });
        assert.deepStrictEqual(result, [[{ tick: 'AAA' }], 1]);
        assert.strictEqual(compute.callCount, 1);
        assert.strictEqual(db._tokensCache.size, 1);
    });

    it('uses a hit inside the TTL without recomputing', async function(){
        const db = makeDb();
        const compute = sinon.stub().resolves([[{ tick: 'AAA' }], 1]);
        const config = makeConfig('AAA');

        await readThrough(db, config, compute);
        sinon.clock.tick(999);
        const result = await readThrough(db, config, compute);

        assert.deepStrictEqual(result, [[{ tick: 'AAA' }], 1]);
        assert.strictEqual(compute.callCount, 1);
    });

    it('recomputes an entry past the TTL', async function(){
        const db = makeDb();
        const compute = sinon.stub();
        const config = makeConfig('AAA');
        compute.onFirstCall().resolves([[{ version: 1 }], 1]);
        compute.onSecondCall().resolves([[{ version: 2 }], 1]);

        await readThrough(db, config, compute);
        sinon.clock.tick(1001);
        const result = await readThrough(db, config, compute);

        assert.deepStrictEqual(result, [[{ version: 2 }], 1]);
        assert.strictEqual(compute.callCount, 2);
    });

    it('keeps values for different keys separate', async function(){
        const db = makeDb();
        const computeA = sinon.stub().resolves([[{ tick: 'AAA' }], 1]);
        const computeB = sinon.stub().resolves([[{ tick: 'BBB' }], 1]);

        await readThrough(db, makeConfig('AAA'), computeA);
        const valueB = await readThrough(db, makeConfig('BBB'), computeB);
        const valueA = await readThrough(db, makeConfig('AAA'), computeA);

        assert.deepStrictEqual(valueA, [[{ tick: 'AAA' }], 1]);
        assert.deepStrictEqual(valueB, [[{ tick: 'BBB' }], 1]);
        assert.strictEqual(computeA.callCount, 1);
        assert.strictEqual(computeB.callCount, 1);
    });
});
