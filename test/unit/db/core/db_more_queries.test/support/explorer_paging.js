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

describe('Database#getOrderbook: bid/ask price aggregation', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('aggregates two orders at the same bid price into one entry (lines 3199-3203)', async () => {
        // Two orders where give_tick==tick2 ('BTC') → both are bids at the same price
        sinon.stub(db, 'doQuery').resolves([
            { action_index: 1 },
            { action_index: 2 }
        ]);
        const samePrice = '0.00010000';
        sinon.stub(db, 'getOrderInfoBatch').resolves({
            1: { give_tick: 'BTC', get_tick: 'XCHAIN', give_price: samePrice, get_price: samePrice, give_remaining: '50', get_remaining: '100' },
            2: { give_tick: 'BTC', get_tick: 'XCHAIN', give_price: samePrice, get_price: samePrice, give_remaining: '30', get_remaining: '60' }
        });
        const config = makeActionConfig('getOrderbook', null);
        config.data.search  = 'XCHAIN';
        config.data.search2 = 'BTC';
        const [data] = await db.getOrderbook(config);
        // Both at same bid price, so they merge into one bid entry
        expect(data.bids.length).to.equal(1);
    });

    it('aggregates two orders at the same ask price into one entry (lines 3209-3213)', async () => {
        // Two orders where give_tick==tick1 ('XCHAIN') → both are asks
        sinon.stub(db, 'doQuery').resolves([
            { action_index: 3 },
            { action_index: 4 }
        ]);
        const samePrice = '0.00010000';
        sinon.stub(db, 'getOrderInfoBatch').resolves({
            3: { give_tick: 'XCHAIN', get_tick: 'BTC', give_price: samePrice, get_price: samePrice, give_remaining: '100', get_remaining: '50' },
            4: { give_tick: 'XCHAIN', get_tick: 'BTC', give_price: samePrice, get_price: samePrice, give_remaining: '200', get_remaining: '100' }
        });
        const config = makeActionConfig('getOrderbook', null);
        config.data.search  = 'XCHAIN';
        config.data.search2 = 'BTC';
        const [data] = await db.getOrderbook(config);
        // Both at same ask price, so they merge into one ask entry
        expect(data.asks.length).to.equal(1);
    });
});


// The action=last branch sizes its LIMIT from the client's own `total`/`start`,
// so it has to re-apply the per-method clamp the earlier branches enforce.
function lastPageConfig(query){
    return makeConfig({
        coin: 'BTC',
        type: 'explorer',
        data: {
            method: 'getSends',
            type: null,
            search: '',
            query: Object.assign({ limit: 10, length: 10, start: 0, offset: false, action: 'last', page: 1, sortorder: 'DESC' }, query),
            sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
            offset: { action: 'last', start: false, stop: false }
        }
    });
}

function stubLastPageQuery(){
    sinon.stub(db, 'getSends').resolves(['SELECT 1', null, '']);
    sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
    sinon.stub(db, 'getQueryOffsets').resolves([false, false]);
    sinon.stub(db, 'getQueryOffsetSql').resolves(['', []]);
}

describe('Database#getQuery (Explorer path)', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('sets offset data and calls method when type=explorer', async () => {
        sinon.stub(db, 'getSends').resolves(['SELECT 1', null, 'SELECT count(1)']);
        sinon.stub(db, 'getQueryWhereSql').resolves('m.action_index IS NOT NULL');
        sinon.stub(db, 'getQueryOffsets').resolves([false, false]);
        sinon.stub(db, 'getQueryOffsetSql').resolves(['', []]);
        const config = makeConfig({
            coin: 'BTC',
            type: 'explorer',
            data: {
                method: 'getSends',
                type: 'address',
                search: 'addr1',
                query: { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'next', page: 1, sortorder: 'DESC' },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: { action: 'next', start: false, stop: false }
            }
        });
        const [query] = await db.getQuery(config);
        expect(query).to.equal('SELECT 1');
        expect(db.getSends.calledOnce).to.be.true;
        expect(db.getQueryOffsets.calledOnce).to.be.true;
    });

    it('sets action=next for getHolders when action=prev (line 367-368)', async () => {
        sinon.stub(db, 'getHolders').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        sinon.stub(db, 'getQueryOffsets').resolves([false, false]);
        sinon.stub(db, 'getQueryOffsetSql').resolves(['', []]);
        const config = makeConfig({
            coin: 'BTC',
            type: 'explorer',
            data: {
                method: 'getHolders',
                type: null,
                search: 'XCHAIN',
                query: { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'prev', page: 1 },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: { action: 'prev', start: false, stop: false }
            }
        });
        await db.getQuery(config);
        // action should have been coerced to 'next' for getHolders
        expect(config.data.query.action).to.equal('next');
    });
});

describe('Database#getQuery (Explorer path)', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('sets order=ASC when action=last (line 381-382)', async () => {
        sinon.stub(db, 'getSends').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        sinon.stub(db, 'getQueryOffsets').resolves([false, false]);
        sinon.stub(db, 'getQueryOffsetSql').resolves(['', []]);
        const config = makeConfig({
            coin: 'BTC',
            type: 'explorer',
            data: {
                method: 'getSends',
                type: null,
                search: '',
                query: { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'last', page: 1, sortorder: 'DESC' },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: { action: 'last', start: false, stop: false }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.order).to.equal('ASC');
    });

    it('clamps the action=last limit to the per-method max on a huge total', async () => {
        stubLastPageQuery();
        const config = lastPageConfig({ total: '1000000000000000' });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.equal(100);
    });

    it('falls back to the page length when the action=last total is not numeric', async () => {
        stubLastPageQuery();
        const config = lastPageConfig({ total: 'abc' });
        await db.getQuery(config);
        expect(Number.isFinite(config.data.sql.limit)).to.be.true;
        expect(config.data.sql.limit).to.equal(10);
    });

    it('falls back to the page length when action=last total is a repeated param', async () => {
        stubLastPageQuery();
        const config = lastPageConfig({ total: ['1', '2'] });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.equal(10);
    });

    it('never emits a negative action=last limit when total is below start', async () => {
        stubLastPageQuery();
        const config = lastPageConfig({ total: '5', start: 20 });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.at.least(1);
    });
});

describe('Database#getQuery (Explorer path)', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('leaves a real last-page limit untouched', async () => {
        stubLastPageQuery();
        const config = lastPageConfig({ total: 47, start: 40 });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.equal(7);
    });

    it('adds getSearch limit as bcadd(start, length) (line 378-379)', async () => {
        sinon.stub(db, 'getSearch').resolves([{}, null, 0]);
        sinon.stub(db, 'getQueryWhereSql').resolves('1=1');
        sinon.stub(db, 'getQueryOffsets').resolves([false, false]);
        sinon.stub(db, 'getQueryOffsetSql').resolves(['', []]);
        const config = makeConfig({
            coin: 'BTC',
            type: 'explorer',
            data: {
                method: 'getSearch',
                type: null,
                search: 'addr',
                query: { limit: 10, length: 10, start: 5, offset: false, total: 50, action: false, page: 1 },
                sql: { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 100, apiOffset: 0 },
                offset: { action: false, start: false, stop: false }
            }
        });
        await db.getQuery(config);
        // limit = bcadd(5, 10) = 15
        expect(Number(config.data.sql.limit)).to.equal(15);
    });
});

let db;

function qoCfg(method, type, action, search, query) {
    return makeConfig({
        coin: 'BTC',
        data: {
            method,
            type,
            search: search || 'addr1',
            query:  Object.assign({ limit: 10, length: 10, start: 0, offset: false, total: 50, action }, query || {}),
            sql:    { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 10 },
            offset: { action }
        }
    });
}

describe('Database#getQueryOffsets: remaining branches', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('builds owner_id where for getTokens + address type (lines 638-640)', async () => {
        // Provide offset1=500 directly so stop-offset query runs using owner_id where clause
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getTokens', 'address', 'next', 'addr1');
        config.data.offset = { action: 'next', start: 500 };
        config.data.query  = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        // Override doQuery to return id from address lookup
        db.doQuery.restore();
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 11 }];
            return Array.from({ length: 5 }, (_, i) => ({ offset_index: 490 - i }));
        });
        const result = await db.getQueryOffsets(config, 500, 10);
        expect(result).to.be.an('array');
        // A token's address is its owner, so the stop query filters on owner_id.
        const queries = db.doQuery.args.map(a => a[1] || '');
        const stopQuery = queries.find(q => q.includes('offset_index') && q.includes('tokens m'));
        expect(stopQuery).to.include('owner_id');
    });

    it('builds default source_id where for getOrders + address type (lines 650-653)', async () => {
        // Provide offset1 directly so stop-offset query runs
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 15 }];
            return Array.from({ length: 5 }, (_, i) => ({ offset_index: 490 - i }));
        });
        const config = qoCfg('getOrders', 'address', 'next', 'addr1');
        config.data.offset = { action: 'next', start: 500 };
        config.data.query  = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        const result = await db.getQueryOffsets(config, 500, 10);
        expect(result).to.be.an('array');
        // Orders take the default address filter, so the stop query uses t1.source_id.
        const queries = db.doQuery.args.map(a => a[1] || '');
        const stopQuery = queries.find(q => q.includes('offset_index') && q.includes('orders m'));
        expect(stopQuery).to.include('t1.source_id');
    });
});

describe('Database#getQueryOffsets: remaining branches', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('a BLOCKS listing + null search + action=first: uses the blocks table', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 850000 }]);
        const config = qoCfg('getBlocks', 'block', 'first', null);
        config.data.search = null;
        config.data.offset = { action: 'first' };
        config.data.query  = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const result = await db.getQueryOffsets(config, false, 10);
        // With no search, the listing pages over every block (blocks b1 WHERE b1.block_index IS NOT NULL).
        expect(db.doQuery.firstCall.args[1]).to.include('blocks b1');
        expect(result).to.be.an('array');
    });
});
