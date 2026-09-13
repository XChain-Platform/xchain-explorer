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
 **********************************************************************
 * Unit tests for the getData() short-TTL result cache.
 *
 * getHolders / getTokens / getBalances are unauthenticated filesort-heavy
 * list queries; getData caches their results per request shape so a burst
 * of identical requests collapses into one DB query. Verifies:
 *   - cache hit for an identical repeated request (per cached method)
 *   - distinct pagination / search / coin inputs do NOT collide
 *   - non-cached methods are never cached
 *   - TTL expiry re-queries
 *   - size cap evicts oldest entries
 *   - a new indexed tip re-queries (a cached list must never outlive
 *     the block it was read at) and a failed tip probe disables the cache
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

// getData consumes getQuery's [query, args, count] tuple; an object query is
// treated as pre-resolved rows with a numeric count as the total.
function stubQuery(db, rows, total) {
    return sinon.stub(db, 'getQuery').resolves([rows, null, total]);
}

// The cache key carries the coin's current tip, which getData reads through
// doQuery. Stub that probe so the suite exercises the cache and not the pool.
// Returns the stub so a test can move the tip or make the probe fail.
function stubTip(db, height = 100) {
    return sinon.stub(db, 'doQuery').resolves([{ tip: height }]);
}

function cfg(method, overrides = {}) {
    const data = Object.assign({ method }, overrides.data || {});
    return makeConfig(Object.assign({}, overrides, { data }));
}

describe('Database#getData result cache', () => {
    let db, tip;
    beforeEach(() => { db = makeDb(); tip = stubTip(db); });
    afterEach(() => {
        sinon.restore();
        delete process.env.EXPLORER_TOKENS_CACHE_MS;
        delete process.env.EXPLORER_TOKENS_CACHE_MAX;
        delete process.env.EXPLORER_TIP_MEMO_MS;
    });

    for (const method of ['getTokens', 'getBalances', 'getHolders']) {
        it(`serves a repeated identical ${method} request from cache`, async () => {
            const stub = stubQuery(db, [{ id: 1 }], 7);
            const config = () => cfg(method, { data: { search: 'PEPE', query: { page: 1 } } });
            const [d1, t1] = await db.getData(config());
            const [d2, t2] = await db.getData(config());
            expect(stub.callCount).to.equal(1);
            expect(d2).to.deep.equal(d1);
            expect(t1).to.equal(7);
            expect(t2).to.equal(7);
        });
    }

    it('does not collide across pages, sort order, search, or coin', async () => {
        const stub = stubQuery(db, [{ id: 1 }], 7);
        await db.getData(cfg('getTokens', { data: { search: 'PEPE', query: { page: 1 } } }));
        await db.getData(cfg('getTokens', { data: { search: 'PEPE', query: { page: 2 } } }));
        await db.getData(cfg('getTokens', { data: { search: 'PEPE', query: { page: 1, sortorder: 'ASC' } } }));
        await db.getData(cfg('getTokens', { data: { search: 'DOGE', query: { page: 1 } } }));
        await db.getData(cfg('getTokens', { coin: 'LTC', data: { search: 'PEPE', query: { page: 1 } } }));
        expect(stub.callCount).to.equal(5);
    });

    it('does not collide across explorer cursor offsets', async () => {
        const stub = stubQuery(db, [{ id: 1 }], 7);
        await db.getData(cfg('getBalances', { type: 'explorer', data: { search: 'addr1', query: { start: 0, length: 10 } } }));
        await db.getData(cfg('getBalances', { type: 'explorer', data: { search: 'addr1', query: { start: 10, length: 10 } } }));
        await db.getData(cfg('getBalances', { type: 'explorer', data: { search: 'addr1', query: { offset: '123', action: 'next' } } }));
        expect(stub.callCount).to.equal(3);
    });

    it('never caches non-listed methods', async () => {
        const stub = stubQuery(db, [{ id: 1 }], 7);
        const config = () => cfg('getSends', { data: { search: 'addr1' } });
        await db.getData(config());
        await db.getData(config());
        expect(stub.callCount).to.equal(2);
    });

    it('re-queries after the TTL expires', async () => {
        const stub = stubQuery(db, [{ id: 1 }], 7);
        const config = () => cfg('getTokens', { data: { search: 'PEPE' } });
        await db.getData(config());
        // Expiry is a stored timestamp, so rewind the entry an hour instead of
        // sleeping the TTL out: no wall clock, no venue-speed race.
        expect(db._tokensCache.size).to.equal(1);
        for (const entry of db._tokensCache.values()) {
            expect(entry.at, 'a cached entry carries its insert time').to.be.a('number');
            entry.at -= 60 * 60 * 1000;
        }
        await db.getData(config());
        expect(stub.callCount).to.equal(2);
    });

    it('caps the cache size and evicts the oldest entry', async () => {
        process.env.EXPLORER_TOKENS_CACHE_MAX = '2';
        const stub = stubQuery(db, [{ id: 1 }], 7);
        await db.getData(cfg('getTokens', { data: { search: 'AAA' } }));
        await db.getData(cfg('getTokens', { data: { search: 'BBB' } }));
        await db.getData(cfg('getTokens', { data: { search: 'CCC' } })); // evicts AAA
        expect(db._tokensCache.size).to.equal(2);
        await db.getData(cfg('getTokens', { data: { search: 'AAA' } })); // miss: re-query
        expect(stub.callCount).to.equal(4);
        await db.getData(cfg('getTokens', { data: { search: 'CCC' } })); // still cached
        expect(stub.callCount).to.equal(4);
    });

    // The cached methods read tables the indexer only rewrites when it
    // applies a block, so an entry read at height N must not answer a request
    // made at height N+1: that is what made /balances/{ADDR} report the
    // pre-deposit balance for the rest of the TTL after the deposit confirmed.
    it('re-queries once the indexed tip moves, within the TTL', async () => {
        process.env.EXPLORER_TIP_MEMO_MS = '0';   // probe the tip on every call
        const stub = stubQuery(db, [{ id: 1 }], 7);
        const config = () => cfg('getBalances', { data: { search: 'addr1' } });

        await db.getData(config());
        await db.getData(config());
        expect(stub.callCount, 'same tip: the second request is a cache hit').to.equal(1);

        tip.resolves([{ tip: 101 }]);
        await db.getData(config());
        expect(stub.callCount, 'new tip: the entry read at the old tip is unreachable').to.equal(2);
        await db.getData(config());
        expect(stub.callCount, 'the new tip caches in turn').to.equal(2);
    });

    it('keeps a pre-genesis (empty blocks table) read cacheable', async () => {
        tip.resolves([{ tip: null }]);
        const stub = stubQuery(db, [], 0);
        const config = () => cfg('getBalances', { data: { search: 'addr1' } });
        await db.getData(config());
        await db.getData(config());
        expect(stub.callCount).to.equal(1);
    });

    it('memoizes the tip probe so a request burst costs one probe', async () => {
        stubQuery(db, [{ id: 1 }], 7);
        for (let i = 0; i < 5; i++)
            await db.getData(cfg('getBalances', { data: { search: 'addr' + i } }));
        expect(tip.callCount, 'one tip probe for the whole burst').to.equal(1);
    });

    it('serves nothing from cache when the tip probe fails', async () => {
        process.env.EXPLORER_TIP_MEMO_MS = '0';
        tip.rejects(new Error('pool gone'));
        const stub = stubQuery(db, [{ id: 1 }], 7);
        const config = () => cfg('getBalances', { data: { search: 'addr1' } });
        const [d1, t1] = await db.getData(config());
        await db.getData(config());
        expect(stub.callCount, 'no freshness check means no caching').to.equal(2);
        expect(d1).to.deep.equal([{ id: 1 }]);
        expect(t1).to.equal(7);
        expect(db._balancesCache === undefined || db._balancesCache.size === 0,
            'a failed probe writes nothing to the cache').to.equal(true);
    });
});
