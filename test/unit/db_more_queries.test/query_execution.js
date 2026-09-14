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
 * Additional unit tests for uncovered methods in src/db/index.js
 *
 * Covers (SQL-builder methods, return [query, args, count]):
 *   - getCoinpays, getCoinpayExpires, getCoinpayObligations
 *   - getMarkets, getMarket, getMarketOrders, getMarketHistory, getOrderbook
 *   - getActions, getAction, getBlocks
 *   - getSearch
 *   - getPublicKey, getTransactionData
 *   - getContracts, getContract, getContractState, getContractBalance
 *   - getExecutions, getExecution, getDeposits, getWithdrawals
 *   - getStakes, getValidators, getPrices, getPriceSnapshots, getDelegations
 *   - getValidatorRewards, getContractStakes, getContractUnstakes, getSlashEvents
 *   - getHistory
 *
 * Covers (helper/detail methods, stub doQuery):
 *   - getMaxBlockIndex, getMaxBlockTime, getMaxActionIndex
 *   - getGatedFileRaw, getBlocksSince, getActionsSince
 *   - getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo
 *   - getCoinpayObligation, getOrderMatchSettlement
 *   - getPublicKey, getTransactionData
 *   - getActionFeeData
 *   - getHistoryData (basic)
 *   - getActionSummaryData (basic pass-through)
 *
 * Covers (LRU cache helpers):
 *   - cacheGet, cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

const {
    configInfo,
    sinon,
    expect,
    makeConfig,
    mockResults,
    makeDb,
    cfg,
    makeActionConfig,
    baseRow,
    stubForType
} = require('./helpers.js');

describe('Database#getQueryOffsetSql: getSlashEvents', () => {
    let db;
    before(() => { db = makeDb(); });

    function cfgOffset(method, action, start, stop) {
        return makeConfig({ data: { method, type: null, offset: { action, start, stop } } });
    }

    it('getSlashEvents action=next: uses m.id field', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getSlashEvents', 'next', 50, null));
        expect(sql).to.equal(' AND m.id < ?');
        expect(args).to.deep.equal([50]);
    });

    it('getSlashEvents action=prev: uses m.id field', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getSlashEvents', 'prev', 10, null));
        expect(sql).to.equal(' AND m.id > ?');
        expect(args).to.deep.equal([10]);
    });
});

// setupConnectionPools is called when config changes.
describe('Database constructor onConfigChanged', () => {
    it('setupConnectionPools is called when configInfo fires triggerConfigChanged', async () => {
        const db = makeDb();
        const stub = sinon.stub(db, 'setupConnectionPools').resolves();
        // Fire the change listener the constructor registered.
        configInfo.triggerConfigChanged();
        // The listener may fire sync or async; flush the microtask queue before asserting.
        await new Promise(r => setImmediate(r));
        expect(stub.called).to.be.true;
        sinon.restore();
    });
});

// Pool cleanup path.
describe('Database#setupConnectionPools', () => {
    it('ends old pool when pools already exist on re-setup', async () => {
        const db = makeDb();
        const endSpy = sinon.stub().resolves();
        db.pools = { BTC: { pool: { end: endSpy } } };
        await db.setupConnectionPools();
        expect(endSpy.calledOnce).to.be.true;
        sinon.restore();
    });

    it('populates db.pools with BTC entry from config', async () => {
        const db = makeDb();
        await db.setupConnectionPools();
        expect(db.pools).to.have.property('BTC');
        expect(db.pools.BTC).to.have.property('pool');
    });

    it('populates db.pools with RBTC entry for regtest', async () => {
        const db = makeDb();
        await db.setupConnectionPools();
        expect(db.pools).to.have.property('RBTC');
    });
});

// General data-fetch path.

describe('Database#getData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [rows, total] when getQuery returns SQL strings', async () => {
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, 'SELECT count(*)']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('count(*)')) return [{ total: 5 }];
            return [{ id: 1 }, { id: 2 }];
        });
        const config = makeConfig({ coin: 'BTC', data: { search: 'test', sql: { where: { offsetArgs: [] }, apiOffset: 0 } } });
        config.type = 'api';
        const [data, total] = await db.getData(config);
        expect(data).to.be.an('array').with.lengthOf(2);
        expect(total).to.equal(5);
    });

    it('returns [object, count] when getQuery returns an object (pre-built data)', async () => {
        const prebuilt = { addresses: ['addr1'], totals: { addresses: 1 } };
        sinon.stub(db, 'getQuery').resolves([prebuilt, null, 2]);
        const config = makeConfig({ coin: 'BTC', data: { search: 'test', sql: { where: { offsetArgs: [] }, apiOffset: 0 } } });
        config.type = 'api';
        const [data, total] = await db.getData(config);
        expect(data).to.equal(prebuilt);
        expect(total).to.equal(2);
    });

    it('appends OFFSET to SQL when config.type=api and apiOffset>0 (lines 322-325)', async () => {
        let capturedQuery = null;
        sinon.stub(db, 'getQuery').resolves(['SELECT * FROM sends', null, '']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { capturedQuery = q; return []; });
        const config = makeConfig({ coin: 'BTC', data: { search: 'test', sql: { where: { offsetArgs: [] }, apiOffset: 100 } } });
        config.type = 'api';
        await db.getData(config);
        expect(capturedQuery).to.include('OFFSET ?');
    });

    it('includes offsetArgs in queryArgs when present', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'getQuery').resolves(['SELECT * FROM sends', ['addr1'], '']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        const config = makeConfig({ coin: 'BTC', data: { search: 'test', sql: { where: { offsetArgs: [999] }, apiOffset: 0 } } });
        config.type = 'api';
        await db.getData(config);
        expect(capturedArgs).to.include(999);
    });
});

describe('Database#getData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // A pure list-all request (no QUERY, no TYPE) has no data-WHERE placeholder, so the
    // phantom args=[config.data.search] many methods seed must not reach the driver: it
    // would prepend to the offset args and bind `m.action_index < ?` to NULL. Dropping it
    // by VALUE rather than discarding the method's whole array is what keeps a method's
    // OWN placeholder bound (getCrossChainMatches' `AND m.network = ?`), which a bare
    // /{COIN}/api/cross_chain_matches otherwise left unset for a 500.
    it('list-all drops the phantom search seed but keeps a method-supplied bind', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'getQuery').resolves(['SELECT 1 WHERE m.network = ?', [null, 'regtest'], '']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        const config = makeConfig({ coin: 'BTC', data: { search: null, type: null, sql: { where: { offsetArgs: [] }, apiOffset: 0 } } });
        config.type = 'api';
        await db.getData(config);
        expect(capturedArgs).to.deep.equal(['regtest']);
    });

    it('list-all still drops a lone phantom search seed (no method bind to keep)', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', [null], '']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        const config = makeConfig({ coin: 'BTC', data: { search: null, type: null, sql: { where: { offsetArgs: [42] }, apiOffset: 0 } } });
        config.type = 'api';
        await db.getData(config);
        expect(capturedArgs).to.deep.equal([42]);
    });

    it('typed request keeps the method args in order (search before the method bind)', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'getQuery').resolves(['SELECT 1 WHERE m.status = ? AND m.network = ?', ['open', 'regtest'], '']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        const config = makeConfig({ coin: 'BTC', data: { search: 'open', type: 'status', sql: { where: { offsetArgs: [] }, apiOffset: 0 } } });
        config.type = 'api';
        await db.getData(config);
        expect(capturedArgs).to.deep.equal(['open', 'regtest']);
    });

    it('list-all count query gets the same de-phantomed base args as the data query', async () => {
        const seen = [];
        sinon.stub(db, 'getQuery').resolves(['SELECT 1 WHERE m.network = ?', [null, 'regtest'], 'SELECT count(*) WHERE m.network = ?']);
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
            seen.push(a);
            return q.includes('count(*)') ? [{ total: 0 }] : [];
        });
        const config = makeConfig({ coin: 'BTC', data: { search: null, type: null, sql: { where: { offsetArgs: [] }, apiOffset: 0 } } });
        config.type = 'api';
        await db.getData(config);
        expect(seen).to.have.lengthOf(2);
        expect(seen[1]).to.deep.equal(['regtest']);
    });
});

let db;

describe('Database#getQuery (API path)', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('calls the method on the db instance and returns [query, args, count]', async () => {
        const fakeResult = ['SELECT 1', null, 'SELECT count(1)'];
        sinon.stub(db, 'getSends').resolves(fakeResult);
        sinon.stub(db, 'getQueryWhereSql').resolves('m.action_index IS NOT NULL');
        const config = makeConfig({
            coin: 'BTC',
            type: 'api',
            data: {
                method: 'getSends',
                type: 'address',
                search: 'addr1',
                query: { limit: 10, page: 1, sortorder: 'DESC' },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: {}
            }
        });
        const [query, args, count] = await db.getQuery(config);
        expect(query).to.equal('SELECT 1');
        expect(db.getSends.calledOnce).to.be.true;
    });

    it('sets apiOffset based on page number', async () => {
        sinon.stub(db, 'getSends').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        const config = makeConfig({
            coin: 'BTC',
            type: 'api',
            data: {
                method: 'getSends',
                type: null,
                search: '',
                query: { limit: 10, page: 3, sortorder: 'DESC' },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: {}
            }
        });
        await db.getQuery(config);
        // page=3, limit=10 → offset=20
        expect(config.data.sql.apiOffset).to.equal(20);
    });
});

describe('Database#getQuery (API path)', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('clamps limit to getMaxMethodResults upper bound', async () => {
        sinon.stub(db, 'getSends').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        const config = makeConfig({
            coin: 'BTC',
            type: 'api',
            data: {
                method: 'getSends',
                type: null,
                search: '',
                query: { limit: 99999, page: 1, sortorder: 'DESC' },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: {}
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.at.most(db.getMaxMethodResults('getSends'));
    });

    it('returns empty strings when method is not a function', async () => {
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        const config = makeConfig({
            coin: 'BTC',
            type: 'api',
            data: {
                method: 'nonExistentMethod',
                type: null,
                search: '',
                query: { limit: 10, page: 1 },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: {}
            }
        });
        const [query, args, count] = await db.getQuery(config);
        expect(query).to.equal('');
        expect(args).to.be.null;
        expect(count).to.equal('');
    });
});

describe('Database#getHistoryData: additional branches', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('uses fast-path max action_index when search is "null"', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            callN++;
            if(callN === 1) return [{ action_index: 5000n }]; // fast-path query
            if(q && q.includes('count(DISTINCT')) return [{ count: 5000 }];
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = 'null';
        config.data.query  = { total: null };
        const [, total] = await db.getHistoryData(config);
        // total comes from the fast-path action_index, stored into q.total
        expect(Number(total)).to.equal(5000);
    });

    it('applies prev offset filter (lines 6000-6003)', async () => {
        let capturedWhere = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 50 }];
            capturedWhere = q;
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: null };
        config.data.offset = { action: 'prev', start: 200 };
        await db.getHistoryData(config);
        // type=block reads `actions` directly (alias a1), not mappings_actions.
        expect(capturedWhere).to.include('a1.action_index > ?');
    });

    it('applies next offset filter (lines 6004-6007)', async () => {
        let capturedWhere = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 50 }];
            capturedWhere = q;
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: null };
        config.data.offset = { action: 'next', start: 300 };
        await db.getHistoryData(config);
        expect(capturedWhere).to.include('a1.action_index < ?');
    });
});
