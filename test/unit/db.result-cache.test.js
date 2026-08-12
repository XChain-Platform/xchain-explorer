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

function cfg(method, overrides = {}) {
    const data = Object.assign({ method }, overrides.data || {});
    return makeConfig(Object.assign({}, overrides, { data }));
}

describe('Database#getData result cache', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => {
        sinon.restore();
        delete process.env.EXPLORER_TOKENS_CACHE_MS;
        delete process.env.EXPLORER_TOKENS_CACHE_MAX;
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
        process.env.EXPLORER_TOKENS_CACHE_MS = '1';
        const stub = stubQuery(db, [{ id: 1 }], 7);
        const config = () => cfg('getTokens', { data: { search: 'PEPE' } });
        await db.getData(config());
        await new Promise(r => setTimeout(r, 10));
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
});
