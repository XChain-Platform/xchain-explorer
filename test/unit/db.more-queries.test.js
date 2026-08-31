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
 * Additional unit tests for uncovered methods in src/db.js
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
 *   - _cacheGet, _cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');
const mockResults              = require('../fixtures/mock-db-results.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

// Shared minimal config used across tests
function cfg(overrides = {}) {
    return makeConfig({ coin: 'BTC', ...overrides });
}

const WHERE_DATA = 'm.action_index IS NOT NULL';

function makeActionConfig(method, type = 'address', extras = {}) {
    return makeConfig({
        data: {
            method,
            search: 'addr1',
            type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: WHERE_DATA, offset: '' }
            },
            ...extras
        }
    });
}

describe('Database LRU cache helpers', () => {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('_cacheGet returns undefined for a key not in the cache', () => {
        expect(db._cacheGet(db._addressIdCache, 'missing')).to.be.undefined;
    });

    it('_cacheSet + _cacheGet round-trip a value', () => {
        db._cacheSet(db._addressIdCache, 'addr1', 42);
        expect(db._cacheGet(db._addressIdCache, 'addr1')).to.equal(42);
    });

    it('_cacheGet returns undefined after the key was consumed (LRU re-inserts)', () => {
        db._cacheSet(db._addressIdCache, 'addr1', 99);
        const v1 = db._cacheGet(db._addressIdCache, 'addr1');
        expect(v1).to.equal(99);
        // After get, the key is re-inserted (LRU touch); it is still present
        expect(db._cacheGet(db._addressIdCache, 'addr1')).to.equal(99);
    });

    it('_cacheSet evicts the LRU entry when the cache is at maxSize', () => {
        const cache = new Map();
        db._cacheSet(cache, 'a', 1, 2);
        db._cacheSet(cache, 'b', 2, 2);
        // Cache is full (size=2). Adding 'c' should evict 'a' (the LRU entry).
        db._cacheSet(cache, 'c', 3, 2);
        expect(cache.has('a')).to.be.false;
        expect(cache.has('b')).to.be.true;
        expect(cache.has('c')).to.be.true;
    });

    it('_cacheSet replaces an existing key without growing the cache', () => {
        db._cacheSet(db._tickIdCache, 'XCHAIN', 7);
        db._cacheSet(db._tickIdCache, 'XCHAIN', 77);
        expect(db._cacheGet(db._tickIdCache, 'XCHAIN')).to.equal(77);
    });
});

describe('Database#init', () => {
    it('calls setupConnectionPools and resolves without throwing', async () => {
        const db = makeDb();
        const spy = sinon.stub(db, 'setupConnectionPools').resolves();
        await db.init();
        expect(spy.calledOnce).to.be.true;
    });
});

describe('Database#getCoinpays', () => {
    let result;
    before(async () => {
        const db = makeDb();
        result = await db.getCoinpays(makeActionConfig('getCoinpays'));
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "coinpays" table', () => {
        const [query] = result;
        expect(query).to.include('coinpays m');
    });

    it('count references "coinpays" table', () => {
        const [, , count] = result;
        expect(count).to.include('coinpays m');
    });

    it('args is null', () => {
        const [, args] = result;
        expect(args).to.be.null;
    });

    it('query includes obligation_action_index and coin_amount', () => {
        const [query] = result;
        expect(query).to.include('m.obligation_action_index');
        expect(query).to.include('m.coin_amount');
    });
});

describe('Database#getCoinpayExpires', () => {
    let result;
    before(async () => {
        const db = makeDb();
        result = await db.getCoinpayExpires(makeActionConfig('getCoinpayExpires'));
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "coinpay_expires" table', () => {
        const [query] = result;
        expect(query).to.include('coinpay_expires m');
    });

    it('args is null', () => {
        expect(result[1]).to.be.null;
    });
});

describe('Database#getCoinpayObligations', () => {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('returns a 3-element array for address type', async () => {
        const result = await db.getCoinpayObligations(makeActionConfig('getCoinpayObligations', 'address'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "coinpay_obligations" table', async () => {
        const [query] = await db.getCoinpayObligations(makeActionConfig('getCoinpayObligations', 'address'));
        expect(query).to.include('coinpay_obligations m');
    });

    it('args has 2 entries for address type', async () => {
        const [, args] = await db.getCoinpayObligations(makeActionConfig('getCoinpayObligations', 'address'));
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal('addr1');
        expect(args[1]).to.equal('addr1');
    });

    it('args has 1 entry for non-address type', async () => {
        const [, args] = await db.getCoinpayObligations(makeActionConfig('getCoinpayObligations', 'block'));
        expect(args).to.be.an('array').with.lengthOf(1);
    });
});

describe('Database#getMarkets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, null, total] when query succeeds with rows', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('count(*) as total')) return [{ total: 2 }];
            return mockResults.marketRows();
        });
        const config = makeActionConfig('getMarkets', 'token', { search: 'XCHAIN' });
        const [data, second, total] = await db.getMarkets(config);
        expect(data).to.be.an('array');
        expect(second).to.be.null;
        expect(total).to.equal(2);
    });

    it('returns empty data when total is 0 and data query returns no rows', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ total: 0 }]; // count query
            return [];                              // data query (always runs)
        });
        const config = makeActionConfig('getMarkets', 'token', { search: 'XCHAIN' });
        const [data, , total] = await db.getMarkets(config);
        expect(data).to.be.an('array').with.lengthOf(0);
        expect(total).to.equal(0);
    });

    it('normalizes tick orientation when tick matches tick2 (reverse=true)', async () => {
        const marketRow = {
            id: 1, tick1: 'BTC', tick2: 'XCHAIN',
            tick1_price: '0.001', tick2_price: '1000',
            tick1_bid: '0.0009', tick2_bid: '999',
            tick1_ask: '0.0011', tick2_ask: '1001',
            tick1_24hr_price: '0.001', tick2_24hr_price: '1000',
            tick1_24hr_high: '0.0012', tick2_24hr_high: '1200',
            tick1_24hr_low: '0.0008', tick2_24hr_low: '800',
            tick1_24hr_change: '1.0', tick2_24hr_change: '-1.0',
            tick1_24hr_volume: '5.0', tick2_24hr_volume: '5000',
            last_updated: 1700000000
        };
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('count(*) as total')) return [{ total: 1 }];
            return [marketRow];
        });
        // search = 'XCHAIN' matches row.tick2 => reverse=true, so tick1 becomes row.tick1 ('BTC')
        const config = makeActionConfig('getMarkets', 'token', { search: 'XCHAIN' });
        const [data] = await db.getMarkets(config);
        expect(data).to.have.lengthOf(1);
        // When reverse=true: tick1 = row.tick1 (BTC), not row.tick2 (XCHAIN)
        expect(data[0].tick1).to.equal('BTC');
    });
});

describe('Database#getMarket', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an array of rows (data)', async () => {
        const marketRow = {
            id: 1, tick1: 'XCHAIN', tick2: 'BTC',
            tick1_price: '100', tick2_price: '0.01',
            tick1_bid: '99', tick2_bid: '0.0099',
            tick1_ask: '101', tick2_ask: '0.0101',
            tick1_24hr_price: '100', tick2_24hr_price: '0.01',
            tick1_24hr_high: '110', tick2_24hr_high: '0.011',
            tick1_24hr_low: '90', tick2_24hr_low: '0.009',
            tick1_24hr_change: '2.0', tick2_24hr_change: '-2.0',
            tick1_24hr_volume: '500', tick2_24hr_volume: '5',
            last_updated: 1700000000
        };
        sinon.stub(db, 'doQuery').resolves([marketRow]);
        const config = makeActionConfig('getMarket', null, { search: 'XCHAIN', search2: 'BTC' });
        config.data.search2 = 'BTC';
        const result = await db.getMarket(config);
        expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('returns [] when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = makeActionConfig('getMarket', null);
        config.data.search2 = 'BTC';
        const result = await db.getMarket(config);
        expect(result).to.be.an('array').with.lengthOf(0);
    });
});

describe('Database#getMarketOrders', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, null, total]', async () => {
        // count returns 0, so no inner query is executed
        sinon.stub(db, 'doQuery').resolves([{ total: 0 }]);
        const config = makeActionConfig('getMarketOrders', null);
        config.data.search2 = 'BTC';
        config.data.search3 = null;
        const [data, second, total] = await db.getMarketOrders(config);
        expect(data).to.be.an('array');
        expect(second).to.be.null;
        expect(total).to.equal(0);
    });

    it('returns data with order info when total > 0', async () => {
        let callN = 0;
        const mockOrderInfo = {
            action_index: 1, give_tick: 'XCHAIN', give_amount: '100',
            get_tick: 'BTC', get_amount: '0.001',
            give_price: '0.00001', get_price: '100000',
            give_remaining: '100', get_remaining: '0.001',
            timestamp: 1700000000, expiration: 900000
        };
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ total: 1 }];
            if(callN === 2) return [{ action_index: 1 }];
            return [];
        });
        // Batched via getOrderInfoBatch (one round-trip) instead of per-row getOrderInfo calls.
        sinon.stub(db, 'getOrderInfoBatch').resolves({ 1: mockOrderInfo });
        const config = makeActionConfig('getMarketOrders', null);
        config.data.search2 = 'BTC';
        config.data.search3 = null;
        const [data, , total] = await db.getMarketOrders(config);
        expect(total).to.equal(1);
        expect(data).to.have.lengthOf(1);
        expect(data[0]).to.have.property('type');
        expect(data[0]).to.have.property('price');
    });
});

describe('Database#getMarketHistory', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, null, total]', async () => {
        sinon.stub(db, 'doQuery').resolves([{ total: 0 }]);
        const config = makeActionConfig('getMarketHistory', null);
        config.data.search2 = 'BTC';
        config.data.search3 = null;
        const [data, second, total] = await db.getMarketHistory(config);
        expect(data).to.be.an('array');
        expect(second).to.be.null;
        expect(total).to.equal(0);
    });

    it('populates data with price/type/amount from order_matches', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ total: 1 }];
            return [{ action_index: 10, give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', block_index: 500, timestamp: 1700000000 }];
        });
        const config = makeActionConfig('getMarketHistory', null);
        config.data.search2 = 'BTC';
        config.data.search3 = null;
        const [data] = await db.getMarketHistory(config);
        expect(data).to.have.lengthOf(1);
        expect(data[0]).to.have.property('type');
        expect(data[0]).to.have.property('price');
        expect(data[0]).to.have.property('amount');
    });
});

describe('Database#getOrderbook', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data] with asks/bids keys when no results', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getOrderInfoBatch').resolves({});
        const config = makeActionConfig('getOrderbook', null);
        config.data.search2 = 'BTC';
        const [data] = await db.getOrderbook(config);
        expect(data).to.have.property('asks').that.is.an('array');
        expect(data).to.have.property('bids').that.is.an('array');
    });

    it('populates asks and bids from order info batch', async () => {
        sinon.stub(db, 'doQuery').resolves([{ action_index: 1 }, { action_index: 2 }]);
        sinon.stub(db, 'getOrderInfoBatch').resolves({
            1: { give_tick: 'XCHAIN', get_tick: 'BTC', give_price: '0.00001', get_price: '100000', give_remaining: '100', get_remaining: '0.001' },
            2: { give_tick: 'BTC', get_tick: 'XCHAIN', give_price: '100000', get_price: '0.00001', give_remaining: '0.001', get_remaining: '100' }
        });
        const config = makeActionConfig('getOrderbook', null);
        config.data.search  = 'XCHAIN';
        config.data.search2 = 'BTC';
        const [data] = await db.getOrderbook(config);
        expect(data.market).to.equal('XCHAIN/BTC');
        // One ask (give=XCHAIN) and one bid (give=BTC which matches tick2)
        expect(data.asks.length + data.bids.length).to.be.greaterThan(0);
    });
});

describe('Database#getActions', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getActions(makeActionConfig('getActions'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "actions" table', async () => {
        const db = makeDb();
        const [query] = await db.getActions(makeActionConfig('getActions'));
        expect(query).to.include('actions m');
    });

    it('includes extra blockIndex filter when q.blockIndex is set', async () => {
        const db = makeDb();
        const config = makeActionConfig('getActions');
        config.data.query = { blockIndex: 500 };
        const [query, args] = await db.getActions(config);
        expect(query).to.include('b1.block_index=?');
        expect(args).to.include(500);
    });

    it('includes extra txid filter when q.txid is set', async () => {
        const db = makeDb();
        const config = makeActionConfig('getActions');
        config.data.query = { txid: 'abc123' };
        const [query, args] = await db.getActions(config);
        expect(query).to.include('t2.hash=?');
        expect(args).to.include('abc123');
    });

    it('includes extra tick filter when q.tick is set', async () => {
        const db = makeDb();
        const config = makeActionConfig('getActions');
        config.data.query = { tick: 'XCHAIN' };
        const [query, args] = await db.getActions(config);
        expect(query).to.include('mappings_actions');
        expect(args).to.include('XCHAIN');
    });
});

describe('Database#getAction', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('calls getActionData with config.data.search', async () => {
        const stub = sinon.stub(db, 'getActionData').resolves({ action: 'SEND' });
        const config = cfg({ data: { search: '100' } });
        const [data] = await db.getAction(config);
        expect(stub.calledOnceWith(config, '100')).to.be.true;
        expect(data).to.deep.equal({ action: 'SEND' });
    });
});

describe('Database#getBlocks', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, null, total]', async () => {
        sinon.stub(db, 'doQuery').resolves([{ total: 0 }]);
        const config = makeActionConfig('getBlocks', null);
        const [data, second, total] = await db.getBlocks(config);
        expect(data).to.be.an('array');
        expect(second).to.be.null;
        expect(total).to.equal(0);
    });

    it('populates block data when blocks are returned', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ total: 1 }];
            if(callN === 2) return [{ block_index: 500, block_time: 1700000000 }];
            return []; // UNION ALL query for action counts
        });
        const config = makeActionConfig('getBlocks', null);
        const [data, , total] = await db.getBlocks(config);
        expect(total).to.equal(1);
        expect(data).to.have.lengthOf(1);
        expect(data[0]).to.have.property('block_index', 500);
        expect(data[0]).to.have.property('actions').that.is.an('object');
    });
});

describe('Database#getSearch', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, null, total]', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 0 }]);
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'addr';
        const [data, second, total] = await db.getSearch(config);
        expect(data).to.be.an('object');
        expect(second).to.be.null;
        expect(total).to.equal(0);
    });

    it('data has totals for addresses, broadcasts, tokens, transactions', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 0 }]);
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'addr';
        const [data] = await db.getSearch(config);
        expect(data.totals).to.have.keys(['addresses', 'broadcasts', 'tokens', 'transactions']);
    });

    it('populates address results when address type matches', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            // 4 count queries run first via Promise.all; address (index 0) matches with count=1
            if(callN <= 4) return [{ count: callN === 1 ? 1 : 0 }];
            return [{ address: 'addr1' }];
        });
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'addr';
        const [data] = await db.getSearch(config);
        expect(data.totals.addresses).to.equal(1);
        expect(data.data).to.be.an('array');
    });

    it('populates token results when token type matches', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN <= 4) return [{ count: callN === 4 ? 2 : 0 }]; // token is last in array
            return [{ tick: 'XCHAIN', description: 'Gas Token' }];
        });
        const config = makeActionConfig('getSearch', 'token');
        config.data.search = 'XCHAIN';
        const [data] = await db.getSearch(config);
        expect(data.totals.tokens).to.equal(2);
    });

    it('returns zero results immediately when search term is too short (< 3 chars)', async () => {
        const spy = sinon.spy(db, 'doQuery');
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'ab';
        const [data, second, total] = await db.getSearch(config);
        expect(total).to.equal(0);
        expect(data.totals.addresses).to.equal(0);
        expect(data.data).to.deep.equal([]);
        expect(spy.callCount).to.equal(0);
    });

    it('returns zero results immediately for empty search string', async () => {
        const spy = sinon.spy(db, 'doQuery');
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = '';
        const [data, , total] = await db.getSearch(config);
        expect(total).to.equal(0);
        expect(spy.callCount).to.equal(0);
    });

    it('proceeds normally when search term meets minimum length (3+ chars)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 0 }]);
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'abc';
        const [data, , total] = await db.getSearch(config);
        expect(total).to.equal(0);
        expect(data.totals).to.have.keys(['addresses', 'broadcasts', 'tokens', 'transactions']);
    });

    it('clamps LIMIT to 100 even when sql.limit is larger', async () => {
        let capturedQuery = null;
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            callN++;
            if(callN <= 4) return [{ count: callN === 1 ? 5 : 0 }];
            capturedQuery = q;
            return [{ address: 'addr1' }];
        });
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'addr';
        config.data.sql.limit = 999;
        await db.getSearch(config);
        expect(capturedQuery).to.include('LIMIT 100');
    });
});

describe('Database#getPublicKey', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the pubkey row when found', async () => {
        sinon.stub(db, 'doQuery').resolves([{ pubkey: 'deadbeef' }]);
        const config = cfg({ data: { search: 'addr1' } });
        const [data] = await db.getPublicKey(config);
        expect(data).to.deep.equal({ pubkey: 'deadbeef' });
    });

    it('returns null when no pubkey found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = cfg({ data: { search: 'addr1' } });
        const [data] = await db.getPublicKey(config);
        expect(data).to.be.null;
    });

    it('query searches pubkeys table joined to index_addresses', async () => {
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { captured = q; return []; });
        await db.getPublicKey(cfg({ data: { search: 'addr1' } }));
        expect(captured).to.include('pubkeys p');
        expect(captured).to.include('index_addresses');
        expect(captured).to.include('a.address=?');
    });
});

describe('Database#getTransactionData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when no transaction found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getTransactionData(cfg(), 'abc123');
        expect(result).to.be.null;
    });

    it('returns the first row when transaction found', async () => {
        const row = { tx_index: 1, block_index: 500, hash: 'abc123', fee: 1000, data: 'XCHN...' };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getTransactionData(cfg(), 'abc123');
        expect(result).to.deep.equal(row);
    });

    it('passes the hash as a query arg', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getTransactionData(cfg(), 'myhash');
        expect(capturedArgs).to.deep.equal(['myhash']);
    });
});

describe('Database#getActionFeeData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when no fee found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getActionFeeData(cfg(), 100)).to.be.null;
    });

    it('returns the fee row when found', async () => {
        const row = { source: 'addr1', destination: 'addr2', tick: 'XCHAIN', amount: '1', method: 'standard', gas_cost: '100', gas_price: '1', xchain_amount: '1', payment_mode: 'xchain', native_coin_amount: '0', native_coin: 'BTC', oracle_round: 1, fee_preference: 'xchain', fee_version: 1 };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getActionFeeData(cfg(), 100);
        expect(result).to.deep.equal(row);
    });

    it('query references fees table joined to actions/transactions', async () => {
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { captured = q; return []; });
        await db.getActionFeeData(cfg(), 100);
        expect(captured).to.include('fees f1');
        expect(captured).to.include('actions');
        expect(captured).to.include('transactions');
    });
});

describe('Database#getHistoryData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, total] for block type with total from count query', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 3 }];
            return mockResults.historyRows();
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: null };
        const [data, total] = await db.getHistoryData(config);
        expect(data).to.be.an('array');
        // The shared list envelope types `total` as a JSON integer and every other
        // list route emits one. History accumulated it through bcadd, which returns a
        // decimal STRING, so /history was the single route answering with a quoted
        // total; assert the type, not just the value.
        expect(total).to.be.a('number');
        expect(total).to.equal(3);
    });

    it('returns a numeric total when the count arrives as a BIGINT string', async () => {
        // Large counts come back from the driver as strings, which is what put
        // total: "124159" on the live /history/recent/recent envelope.
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: '124159' }];
            return mockResults.historyRows();
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: null };
        const [, total] = await db.getHistoryData(config);
        expect(total).to.be.a('number');
        expect(total).to.equal(124159);
    });

    it('returns a numeric total when one is passed on the querystring', async () => {
        // A querystring value is always a string; passing it straight through put the
        // same quoted total on every paginated page.
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: '124159' };
        const [, total] = await db.getHistoryData(config);
        expect(total).to.be.a('number');
        expect(total).to.equal(124159);
    });

    it('skips count query when q.total is already set', async () => {
        let countCalled = false;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) { countCalled = true; return [{ count: 5 }]; }
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'block');
        config.data.search = '500';
        config.data.query  = { total: 10 };
        const [, total] = await db.getHistoryData(config);
        expect(countCalled).to.be.false;
        expect(total).to.equal(10);
    });

    it('uses address id for address type', async () => {
        sinon.stub(db, 'getAddressId').resolves(42);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 0 }];
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'address');
        config.data.search = 'addr1';
        config.data.query  = { total: null };
        await db.getHistoryData(config);
        expect(db.getAddressId.calledOnceWith(config, 'addr1')).to.be.true;
    });

    it('uses tick id for token type', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 0 }];
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeActionConfig('getHistory', 'token');
        config.data.search = 'XCHAIN';
        config.data.query  = { total: null };
        await db.getHistoryData(config);
        expect(db.getTickId.calledOnceWith(config, 'XCHAIN')).to.be.true;
    });
});

describe('Database#getActionSummaryData', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // These cases stub getActionData to pin the projection loop, so the page-level
        // shared-leg prefetch has no reader; null is the "no preload" state getActionData
        // already handles. Its parity is covered against a real MariaDB in
        // test/integration/action-preload-parity.test.js.
        sinon.stub(db, '_buildActionPreload').resolves(null);
    });
    afterEach(() => { sinon.restore(); });

    it('returns the same array it was passed (pass-through)', async () => {
        sinon.stub(db, 'getActionData').resolves({ action: 'SEND', status: 'valid' });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result).to.equal(actions);
    });

    it('adds status to each action item', async () => {
        sinon.stub(db, 'getActionData').resolves({ action: 'SEND', status: 'valid' });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].status).to.equal('valid');
    });

    it('returns empty array when called with empty array', async () => {
        const result = await db.getActionSummaryData(cfg(), []);
        expect(result).to.deep.equal([]);
    });

    it('populates details.source for SEND actions', async () => {
        sinon.stub(db, 'getActionData').resolves({
            action: 'SEND',
            status: 'valid',
            sends: [{ source: 'addr1', destination: 'addr2', tick: 'XCHAIN', amount: '100', status: 'valid' }]
        });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].details).to.have.property('source', 'addr1');
    });
});

describe('Database#getMaxBlockIndex', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the max block_index number when row found', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: 850000 }]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(850000);
    });

    it('returns 0 when no blocks found (max_index is null)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(0);
    });

    it('returns 0 when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(0);
    });
});

describe('Database#getMaxBlockTime', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the block_time number when row found', async () => {
        sinon.stub(db, 'doQuery').resolves([{ block_time: 1700000000 }]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(1700000000);
    });

    it('returns 0 when block_time is null', async () => {
        sinon.stub(db, 'doQuery').resolves([{ block_time: null }]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(0);
    });

    it('returns 0 when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(0);
    });
});

describe('Database#getMaxActionIndex', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // This value is the WebSocket live/catch-up cursor, so it answers in BigInt.
    // Number() collapsed two consecutive indices above 2^53 onto one value and
    // the poll loop then stalled or skipped a NEW_ACTION frame.
    it('returns the max action_index as an exact BigInt', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: 99999 }]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(99999n);
    });

    it('keeps an above-2^53 max_index exact instead of rounding it', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: '9007199254740995' }]);
        const max = await db.getMaxActionIndex(cfg());
        expect(max).to.equal(9007199254740995n);
        expect(String(max)).to.equal('9007199254740995');
    });

    it('returns 0n when max_index is null', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(0n);
    });

    it('returns 0n when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(0n);
    });
});

describe('Database#getGatedFileRaw', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns result from doQuery', async () => {
        sinon.stub(db, 'doQuery').resolves([{ raw_data: Buffer.from('hello') }]);
        const result = await db.getGatedFileRaw(cfg(), 42);
        expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('returns [] (falsy from doQuery) when no row found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getGatedFileRaw(cfg(), 999);
        expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('passes actionIndex as a Number arg', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getGatedFileRaw(cfg(), '42');
        expect(capturedArgs).to.deep.equal([42]);
    });
});

// Non-gated FILE bytes read from the colocated decoder DB.
describe('Database#getFileRaw', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.decoderDb = { BTC: 'XChain_Decoder_BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('returns raw bytes + declared MIME type + the stored action string when the decoder row matches by hash', async () => {
        const bytes = Buffer.from('png-bytes');
        const action = 'FILE|0|logo.png|image/png|Logo|';
        const stub  = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ hash: 'abc123', type: 'image/png' }]);
        stub.onSecondCall().resolves([{ raw_data: bytes, data: action }]);
        const result = await db.getFileRaw(cfg(), 42);
        // `data` carries the FULL stored ACTION string so the serve path can
        // derive the trailing COMPRESSION field at serve time rather than
        // trusting a parsed-at-ingest column.
        expect(result).to.deep.equal({ raw_data: bytes, type: 'image/png', data: action });
        // The decoder read must be database-qualified and matched by tx HASH
        // (tx ids are numbered independently per DB and cannot be joined)
        const [, decoderQuery, decoderArgs] = stub.secondCall.args;
        expect(decoderQuery).to.include('`XChain_Decoder_BTC`.transactions');
        expect(decoderQuery).to.include('`XChain_Decoder_BTC`.index_transactions');
        expect(decoderQuery).to.include('t1.data');
        expect(decoderArgs).to.deep.equal(['abc123']);
    });

    it('returns null when the FILE action is unknown', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getFileRaw(cfg(), 999)).to.equal(null);
    });

    it('returns null when no decoder DB is configured for the coin', async () => {
        db.decoderDb = {};
        sinon.stub(db, 'doQuery').resolves([{ hash: 'abc123', type: 'image/png' }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });

    it('returns null when the decoder DB name fails the identifier guard', async () => {
        db.decoderDb = { BTC: 'bad`name; DROP' };
        sinon.stub(db, 'doQuery').resolves([{ hash: 'abc123', type: 'image/png' }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });

    it('returns null when the decoder row has no stored bytes', async () => {
        const stub = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ hash: 'abc123', type: 'image/png' }]);
        stub.onSecondCall().resolves([{ raw_data: null }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });
});

// Project registry queries (protocol/Project_Registry.md).
describe('Database#getProjectRosterInfo', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('resolves the latest owner-valid roster link + item count', async () => {
        const stub = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ link_action_index: 74, roster_action_index: 73 }]);
        stub.onSecondCall().resolves([{ total: 2 }]);
        // Edit resolution off: the pinned index IS the membership index (the armed
        // case is covered in db.list-edit-resolution.test.js).
        sinon.stub(db, '_isListEditResolutionActiveAtTip').resolves(false);
        const info = await db.getProjectRosterInfo(cfg(), 'PROJECTX');
        expect(info).to.deep.equal({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 2 });
        // The roster query must filter to the LOCAL chain on BOTH link sides and
        // to valid TICK-type lists, newest link first
        const [, query, args] = stub.firstCall.args;
        expect(query).to.include("ls.type='1'");
        expect(query).to.include('ORDER BY l.action_index DESC');
        expect(args).to.deep.equal(['BTC', 'BTC', 'PROJECTX']);
    });

    it('returns null when no roster link exists', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getProjectRosterInfo(cfg(), 'PROJECTX')).to.equal(null);
    });

    it('returns null when the base chain for the coin key is unknown', async () => {
        db.baseCoin = {};
        sinon.stub(db, 'doQuery').resolves([{ link_action_index: 1, roster_action_index: 1 }]);
        expect(await db.getProjectRosterInfo(cfg(), 'PROJECTX')).to.equal(null);
    });
});

describe('Database#getTokenProjects', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    // Edit resolution off: the single-query legacy form runs, and the pinned
    // index IS the membership index (the armed, two-phase path is covered in
    // db.list-edit-resolution.test.js).
    beforeEach(() => { sinon.stub(Database.prototype, '_isListEditResolutionActiveAtTip').resolves(false); });

    it('returns normalized membership rows', async () => {
        sinon.stub(db, 'doQuery').resolves([{ project: 'PROJECTX', link_action_index: 74n, roster_action_index: 73n }]);
        const rows = await db.getTokenProjects(cfg(), 'TOKENONE');
        expect(rows).to.deep.equal([{ project: 'PROJECTX', link_action_index: 74, roster_action_index: 73, membership_action_index: 73 }]);
    });

    it('returns [] for a token on no current roster', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTokenProjects(cfg(), 'LONER')).to.deep.equal([]);
    });

    it('matches the CURRENT roster only (latest link per project)', async () => {
        const stub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getTokenProjects(cfg(), 'TOKENONE');
        const [, query] = stub.firstCall.args;
        expect(query).to.include('MAX(l.action_index)');
        expect(query).to.include('GROUP BY i1.tick_id');
    });
});

describe('Database#getProject', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('returns [null] when the tick has no roster (→ 400 at the API layer)', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves(null);
        const [data] = await db.getProject(makeActionConfig('getProject', 'token'));
        expect(data).to.equal(null);
    });

    it('returns project + member rows when a roster exists', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 1 });
        sinon.stub(db, 'doQuery').resolves([{ tick: 'TOKENONE', supply: '1', max_supply: '1', decimals: 0, lock_max_supply: 1 }]);
        const config = makeActionConfig('getProject', 'token');
        config.data.search = 'PROJECTX';
        const [data] = await db.getProject(config);
        expect(data.tick).to.equal('PROJECTX');
        expect(data.roster_action_index).to.equal(73);
        expect(data.members).to.have.length(1);
        expect(data.members[0].tick).to.equal('TOKENONE');
    });

    it('echoes a mixed-case tick unchanged, so the value round-trips as a URL', async () => {
        // Uppercasing the echo while the lookup stays case-sensitive makes the tick
        // handed back 404 when fed into /api/project/{TICK} for any tick that is not
        // already all upper case.
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 0 });
        sinon.stub(db, 'doQuery').resolves([]);
        const config = makeActionConfig('getProject', 'token');
        config.data.search = 'XCPROJ819a01';
        const [data] = await db.getProject(config);
        expect(data.tick).to.equal('XCPROJ819a01');
    });
});

describe('Database#getProjectTokens', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('short-circuits to an empty datatable when no roster exists', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves(null);
        const [query, args, count] = await db.getProjectTokens(makeActionConfig('getProjectTokens', 'roster'));
        expect(query).to.deep.equal([]);
        expect(count).to.equal(0);
    });

    it('builds a token-shaped query scoped to the roster list_items', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 2 });
        const [query, args, count] = await db.getProjectTokens(makeActionConfig('getProjectTokens', 'roster'));
        expect(query).to.include('list_items');
        expect(query).to.include('li.action_index=?');
        expect(args).to.deep.equal([73]);
        expect(count).to.include('count(*)');
    });
});

describe('Database#getBlocksSince', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an array of block rows', async () => {
        sinon.stub(db, 'doQuery').resolves([{ block_index: 501, block_time: 1700001000 }]);
        const result = await db.getBlocksSince(cfg(), 500, 10);
        expect(result).to.be.an('array').with.lengthOf(1);
        expect(result[0].block_index).to.equal(501);
    });

    it('returns [] when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        const result = await db.getBlocksSince(cfg(), 500, 10);
        expect(result).to.deep.equal([]);
    });

    it('passes sinceBlockIndex and limit as args', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getBlocksSince(cfg(), 800000, 50);
        expect(capturedArgs).to.deep.equal([800000, 50]);
    });
});

describe('Database#getActionsSince', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an array of action rows', async () => {
        sinon.stub(db, 'doQuery').resolves([{ action_index: 101, action: 'SEND' }]);
        const result = await db.getActionsSince(cfg(), 100, 10);
        expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('returns [] when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        const result = await db.getActionsSince(cfg(), 100, 10);
        expect(result).to.deep.equal([]);
    });

    it('passes sinceActionIndex and limit as args', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getActionsSince(cfg(), 5000, 25);
        expect(capturedArgs).to.deep.equal([5000, 25]);
    });

    it('query selects action_index, action, tx_hash, source', async () => {
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { captured = q; return []; });
        await db.getActionsSince(cfg(), 0, 10);
        expect(captured).to.include('a1.action_index');
        expect(captured).to.include('a3.action');
        expect(captured).to.include('NULL as status');
    });
});

describe('Database#getAddressBalances', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an array of balance rows', async () => {
        sinon.stub(db, 'doQuery').resolves([{ tick: 'XCHAIN', amount: '100' }]);
        const result = await db.getAddressBalances(cfg(), 'addr1');
        expect(result).to.be.an('array').with.lengthOf(1);
        expect(result[0].tick).to.equal('XCHAIN');
    });

    it('returns [] when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        const result = await db.getAddressBalances(cfg(), 'addr1');
        expect(result).to.deep.equal([]);
    });

    it('passes address as arg', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getAddressBalances(cfg(), 'bc1qtest');
        expect(capturedArgs).to.deep.equal(['bc1qtest']);
    });
});

describe('Database#getTokenInfo', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the token row when found', async () => {
        const row = { tick: 'XCHAIN', supply: '21000000', decimals: 8, description: 'Gas', holders: 500 };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getTokenInfo(cfg(), 'XCHAIN');
        expect(result).to.deep.equal(row);
    });

    it('returns null when no token found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTokenInfo(cfg(), 'MISSING')).to.be.null;
    });

    it('passes tick twice as args (for subquery + WHERE)', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getTokenInfo(cfg(), 'XCHAIN');
        expect(capturedArgs).to.deep.equal(['XCHAIN', 'XCHAIN']);
    });
});

describe('Database#getMarketInfo', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the market row when found', async () => {
        const row = { tick1: 'XCHAIN', tick2: 'BTC', last_price: '100', volume_24h: '1000', bid: '99', ask: '101' };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getMarketInfo(cfg(), 'XCHAIN', 'BTC');
        expect(result).to.deep.equal(row);
    });

    it('returns null when no market found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMarketInfo(cfg(), 'XCHAIN', 'BTC')).to.be.null;
    });

    it('passes [tick1, tick2] as args', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getMarketInfo(cfg(), 'XCHAIN', 'BTC');
        expect(capturedArgs).to.deep.equal(['XCHAIN', 'BTC']);
    });
});

describe('Database#getDispenserInfo', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the dispenser row when found', async () => {
        const row = { action_index: 70, source: 'addr1', give_tick: 'XCHAIN', give_amount: '10', give_remaining: '10', get_tick: 'BTC', get_amount: '0.0001', expiration: 0, status: 'open' };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getDispenserInfo(cfg(), 70);
        expect(result).to.deep.equal(row);
    });

    it('returns null when dispenser not found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getDispenserInfo(cfg(), 9999)).to.be.null;
    });
});

describe('Database#getCoinpayObligation', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the obligation row when found', async () => {
        const row = { obligation_action_index: 100, order_match_action_index: 100, payer_address: 'addr1', payee_address: 'addr2', coin_amount: '0.01', expiration: 900000 };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getCoinpayObligation(cfg(), 100);
        expect(result).to.deep.equal(row);
    });

    it('returns null when not found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getCoinpayObligation(cfg(), 9999)).to.be.null;
    });
});

describe('Database#getOrderMatchSettlement', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the settlement row when found', async () => {
        const row = { action_index: 55, settlement_type: 'coinpay' };
        sinon.stub(db, 'doQuery').resolves([row]);
        const result = await db.getOrderMatchSettlement(cfg(), 55);
        expect(result).to.deep.equal(row);
    });

    it('returns null when not found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getOrderMatchSettlement(cfg(), 9999)).to.be.null;
    });
});

describe('Database#getOrderInfo', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns false when order is not found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getOrderEditInfo').resolves({ expiration: false, allow_list: false, block_list: false });
        sinon.stub(db, 'getOrderAmountsRemaining').resolves(['0', '0']);
        const result = await db.getOrderInfo(cfg(), 999);
        expect(result).to.satisfy(v => v === false || (typeof v === 'object' && Object.keys(v).length === 0));
    });

    it('returns enriched order object when found', async () => {
        const row = {
            action_index: 60n, block_index: 450n, block_time: 1699500000n,
            allow_list: 0n, block_list: 0n,
            give_tick: 'XCHAIN', get_tick: 'BTC',
            give_amount: '100', get_amount: '0.001',
            source: 'addr1', get_address: 'addr2', expiration: 900000,
            memo: null, status: 'valid', order_status: 'open'
        };
        sinon.stub(db, 'doQuery').resolves([row]);
        sinon.stub(db, 'getOrderEditInfo').resolves({ expiration: false, allow_list: false, block_list: false });
        sinon.stub(db, 'getOrderAmountsRemaining').resolves(['100', '0.001']);
        const result = await db.getOrderInfo(cfg(), 60);
        expect(result).to.be.an('object');
        // give_price/get_price are mathjs BigNumbers (not plain strings)
        expect(result.give_price).to.exist;
        expect(result.get_price).to.exist;
        expect(result.give_remaining).to.equal('100');
        expect(result.get_remaining).to.equal('0.001');
    });
});

describe('Database#getOrderEditInfo', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns default edit object when no edits found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getOrderEditInfo(cfg(), 60);
        expect(result).to.deep.equal({ expiration: false, allow_list: false, block_list: false });
    });

    it('returns updated edit fields when edits exist', async () => {
        sinon.stub(db, 'doQuery').resolves([{ expiration: 900001, allow_list: 1, block_list: null }]);
        const result = await db.getOrderEditInfo(cfg(), 60);
        expect(result.expiration).to.equal(900001);
        expect(result.allow_list).to.equal(1);
        expect(result.block_list).to.be.false;
    });
});

describe('Database#getOrderAmountsRemaining', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [give_remaining, get_remaining] starting from order amounts', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ give_coin_id: 1, give_tick_id: 1, give_amount: '100', get_coin_id: 1, get_tick_id: 2, get_amount: '0.001', status: 'valid' }];
            return []; // No matches
        });
        const [give, get] = await db.getOrderAmountsRemaining(cfg(), 60);
        expect(give).to.equal('100');
        expect(get).to.equal('0.001');
    });

    it('deducts matched amounts from remaining when acting as GET side', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{ give_coin_id: 1, give_tick_id: 1, give_amount: '100', get_coin_id: 1, get_tick_id: 2, get_amount: '200', status: 'valid' }];
            // This order (60) is the GET side: get_action_index==60
            // give_amount = row.give_amount = '40', get_amount = row.get_amount = '80'
            // give_remaining = bcsub('100','40') = 60, get_remaining = bcsub('200','80') = 120
            return [{ give_action_index: 999, get_action_index: 60, give_amount: '40', get_amount: '80' }];
        });
        const [give, get] = await db.getOrderAmountsRemaining(cfg(), 60);
        // bcsub with decimals=0: whole numbers deducted correctly
        expect(Number(give)).to.equal(60);   // 100 - 40 = 60
        expect(Number(get)).to.equal(120);   // 200 - 80 = 120
    });
});

describe('Database#getOrderInfoBatch', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns empty object when action_indexes is empty', async () => {
        const result = await db.getOrderInfoBatch(cfg(), []);
        expect(result).to.deep.equal({});
    });

    it('returns empty object when action_indexes is null/undefined', async () => {
        const result = await db.getOrderInfoBatch(cfg(), null);
        expect(result).to.deep.equal({});
    });

    it('returns a map keyed by action_index', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callN++;
            if(callN === 1) return [{
                action_index: 60n, block_index: 450n, block_time: 1699500000n,
                allow_list: 0n, block_list: 0n,
                give_tick: 'XCHAIN', get_tick: 'BTC',
                give_amount: '100', get_amount: '0.001',
                source: 'addr1', get_address: 'addr2', expiration: 900000,
                memo: null, status: 'valid', order_status: 'open', get_coin: 'BTC'
            }];
            if(callN === 2) return []; // order edits
            if(callN === 3) return [{ give_coin_id: 1, give_tick_id: 1, give_amount: '100', get_coin_id: 1, get_tick_id: 2, get_amount: '0.001', status: 'valid' }];
            return [];
        });
        const map = await db.getOrderInfoBatch(cfg(), [60]);
        expect(map).to.have.property(60);
        expect(map[60]).to.have.property('give_price');
        expect(map[60]).to.have.property('get_price');
    });
});

// Wraps getHistoryData with [data, null, count].
describe('Database#getHistory', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns a 3-element array [data, null, count]', async () => {
        sinon.stub(db, 'getHistoryData').resolves([mockResults.historyRows(), 2]);
        const config = makeActionConfig('getHistory', 'address');
        const result = await db.getHistory(config);
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('second element is always null', async () => {
        sinon.stub(db, 'getHistoryData').resolves([[], 0]);
        const [, second] = await db.getHistory(makeActionConfig('getHistory', 'address'));
        expect(second).to.be.null;
    });

    it('passes data and count from getHistoryData', async () => {
        const mockData = mockResults.historyRows();
        sinon.stub(db, 'getHistoryData').resolves([mockData, 99]);
        const [data, , count] = await db.getHistory(makeActionConfig('getHistory', 'block'));
        expect(data).to.equal(mockData);
        expect(count).to.equal(99);
    });

    it('delegates to getHistoryData with the same config', async () => {
        const stub = sinon.stub(db, 'getHistoryData').resolves([[], 0]);
        const config = makeActionConfig('getHistory', 'token');
        await db.getHistory(config);
        expect(stub.calledOnceWith(config)).to.be.true;
    });
});

describe('Database#getContracts', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContracts(makeActionConfig('getContracts'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contracts" table with code_hash', async () => {
        const db = makeDb();
        const [query] = await db.getContracts(makeActionConfig('getContracts'));
        expect(query).to.include('contracts m');
        expect(query).to.include('m.code_hash');
    });

    it('args is null', async () => {
        const db = makeDb();
        expect((await db.getContracts(makeActionConfig('getContracts')))[1]).to.be.null;
    });
});

describe('Database#getContract', () => {
    // getContract is a single-record data method (returns [data]); the
    // /api/contract/{idx} route serves one record, not a datatable. It LEFT
    // JOINs the permissions manifest (protocol/Controller_Bound_Tokens.md).
    afterEach(() => { sinon.restore(); });

    function contractRow(overrides = {}) {
        return Object.assign({
            action: 'DEPLOY', action_index: 42, action_format: 0, source: 'src',
            code: 'module.exports={}', code_hash: 'h', api_version: 1,
            cooldown_blocks: null, slash_destination: null, block_index: 5,
            timestamp: 1, tx_hash: 'tx', tx_index: 4, status: 'valid',
            permissions: null, max_take_bps: null
        }, overrides);
    }

    it('returns [data] (single record), null when none found', async () => {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const config = makeActionConfig('getContract', 'contract');
        config.data.search = '42';
        const result = await db.getContract(config);
        expect(result).to.be.an('array').with.lengthOf(1);
        expect(result[0]).to.be.null;
    });

    it('selects m.code and joins the contract_permissions manifest', async () => {
        const db = makeDb();
        // Capture only the FIRST query: getContract now issues a second
        // point-read for constructor params after the main select.
        let query;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { if(query === undefined) query = q; return [contractRow()]; });
        const config = makeActionConfig('getContract', 'contract');
        config.data.search = '42';
        await db.getContract(config);
        expect(query).to.include('m.code,');
        expect(query).to.include('contracts m');
        expect(query).to.include('LEFT  JOIN contract_permissions cp');
    });

    it('passes the search value as the query arg', async () => {
        const db = makeDb();
        // Capture only the FIRST call's args (see above: second ctor read).
        let args;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { if(args === undefined) args = a; return [contractRow()]; });
        const config = makeActionConfig('getContract', 'contract');
        config.data.search = '99';
        await db.getContract(config);
        expect(args).to.be.an('array');
        expect(args[0]).to.equal('99');
    });
});

describe('Database#getContractState', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractState(makeActionConfig('getContractState'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_state" with latest-per-key subquery', async () => {
        const db = makeDb();
        const [query] = await db.getContractState(makeActionConfig('getContractState'));
        expect(query).to.include('contract_state cs');
        expect(query).to.include('state_key');
        expect(query).to.include('MAX(id)');
    });

    it('args contains the search value', async () => {
        const db = makeDb();
        const config = makeActionConfig('getContractState', 'contract');
        config.data.search = '5';
        const [, args] = await db.getContractState(config);
        expect(args[0]).to.equal('5');
    });
});

describe('Database#getContractBalance', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractBalance(makeActionConfig('getContractBalance'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('reads the standard balances table via the contract C: address', async () => {
        const db = makeDb();
        const [query, args] = await db.getContractBalance(makeActionConfig('getContractBalance'));
        // custody now lives in `balances` keyed by the derived C: address.
        // the legacy `contract_balances` table was removed.
        expect(query).to.not.include('contract_balances');
        expect(query).to.include('balances m');
        expect(query).to.include('index_addresses a2');
        expect(query).to.include('t3.tick');
        expect(args).to.be.an('array').with.lengthOf(1);
        expect(String(args[0])).to.match(/^C:/);
    });
});

describe('Database#getExecutions', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getExecutions(makeActionConfig('getExecutions'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_executions" table', async () => {
        const db = makeDb();
        const [query] = await db.getExecutions(makeActionConfig('getExecutions'));
        expect(query).to.include('contract_executions m');
        expect(query).to.include('m.method_name');
        expect(query).to.include('m.gas_used');
    });
});

describe('Database#getExecution', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getExecution(makeActionConfig('getExecution'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query includes input_params and error_message fields', async () => {
        const db = makeDb();
        const [query] = await db.getExecution(makeActionConfig('getExecution'));
        expect(query).to.include('m.input_params');
        expect(query).to.include('m.error_message');
    });
});

describe('Database#getDeposits', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getDeposits(makeActionConfig('getDeposits'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "deposits" table with tick and amount', async () => {
        const db = makeDb();
        const [query] = await db.getDeposits(makeActionConfig('getDeposits'));
        expect(query).to.include('deposits m');
        expect(query).to.include('t3.tick');
        expect(query).to.include('m.amount');
    });
});

describe('Database#getWithdrawals', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getWithdrawals(makeActionConfig('getWithdrawals'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "withdrawals" table', async () => {
        const db = makeDb();
        const [query] = await db.getWithdrawals(makeActionConfig('getWithdrawals'));
        expect(query).to.include('withdrawals m');
    });
});

describe('Database#getStakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getStakes(makeActionConfig('getStakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "stakes" table with signing_pubkey', async () => {
        const db = makeDb();
        const [query] = await db.getStakes(makeActionConfig('getStakes'));
        expect(query).to.include('stakes m');
        expect(query).to.include('signing_pubkey');
        expect(query).to.include('m.version');
    });
});

describe('Database#getValidators', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getValidators(makeActionConfig('getValidators'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query filters by s1.status="valid"', async () => {
        const db = makeDb();
        const [query] = await db.getValidators(makeActionConfig('getValidators'));
        expect(query).to.include("s1.status='valid'");
    });

    it('count also filters by s1.status="valid"', async () => {
        const db = makeDb();
        const [, , count] = await db.getValidators(makeActionConfig('getValidators'));
        expect(count).to.include("s1.status='valid'");
    });
});

describe('Database#getPrices', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getPrices(makeActionConfig('getPrices'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "prices" table with coin/fiat/tick joins', async () => {
        const db = makeDb();
        const [query] = await db.getPrices(makeActionConfig('getPrices'));
        expect(query).to.include('prices m');
        expect(query).to.include('index_coins');
        expect(query).to.include('index_fiats');
        expect(query).to.include('m.round_number');
    });
});

describe('Database#getPriceSnapshots', () => {
    // price_snapshots is hub-mirrored: xchain-sync never replicates it in any
    // channel, so it is served only from the mandatory co-located hub DB. These
    // structural tests configure that hub DB so the query builds; the "no hub DB ->
    // fail loud" behavior has its own test below.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "price_snapshots" table', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(query).to.include('price_snapshots m');
        expect(query).to.include('m.coin_pair');
        expect(query).to.include('m.price');
    });

    it('checkpoint hub DB configured -> database-qualifies price_snapshots (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(query).to.include('`XChain_Hub`.price_snapshots m');
        expect(count).to.include('`XChain_Hub`.price_snapshots m');
    });

    it('no checkpoint hub DB -> fails loud (no silent empty local mirror)', async () => {
        const db = makeDb();
        // checkpointDb is empty by default. price_snapshots only ever arrives via
        // hub_db_sync, so a thin replica's local copy is an empty table the live
        // stream never fills: throw rather than serve it as a real result set.
        let err = null;
        try { await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.include('price_snapshots');
    });

    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getDelegations', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "delegations" table', async () => {
        const db = makeDb();
        const [query] = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(query).to.include('delegations m');
    });

    it('query exposes activation_block / deactivation_block (parity with getStakes)', async () => {
        const db = makeDb();
        const [query] = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(query).to.include('m.activation_block');
        expect(query).to.include('m.deactivation_block');
    });
});

describe('Database#getValidatorRewards', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getValidatorRewards(makeActionConfig('getValidatorRewards'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "validator_rewards" table', async () => {
        const db = makeDb();
        const [query] = await db.getValidatorRewards(makeActionConfig('getValidatorRewards'));
        expect(query).to.include('validator_rewards m');
        expect(query).to.include('m.reward_type');
    });
});

describe('Database#getContractStakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractStakes(makeActionConfig('getContractStakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_stakes" table', async () => {
        const db = makeDb();
        const [query] = await db.getContractStakes(makeActionConfig('getContractStakes'));
        expect(query).to.include('contract_stakes m');
        expect(query).to.include('m.target_contract_index');
    });
});

describe('Database#getContractUnstakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractUnstakes(makeActionConfig('getContractUnstakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_unstakes" table', async () => {
        const db = makeDb();
        const [query] = await db.getContractUnstakes(makeActionConfig('getContractUnstakes'));
        expect(query).to.include('contract_unstakes m');
        expect(query).to.include('m.cooldown_end_block');
    });
});

describe('Database#getSlashEvents', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "slash_events" table (no action_index)', async () => {
        const db = makeDb();
        const [query] = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(query).to.include('slash_events m');
        expect(query).to.include('m.execution_index');
        expect(query).to.include('m.target_contract_index');
    });

    it('ORDER BY uses m.id (not m.action_index)', async () => {
        const db = makeDb();
        const [query] = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getDecoderTip', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when decoderDb has no entry for coin', async () => {
        db.decoderDb = {};
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns null for unsafe DB identifier', async () => {
        db.decoderDb = { BTC: 'bad name; DROP TABLE' };
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns the max block_index number from the decoder DB', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').resolves([{ max_index: 850000 }]);
        expect(await db.getDecoderTip(cfg())).to.equal(850000);
    });

    it('returns null when doQuery throws (no cross-DB grant)', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').rejects(new Error('no grant'));
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns null when max_index is null', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });
});

describe('Database#getQueryWhereSql: additional branches', () => {
    let db;
    before(() => { db = makeDb(); });

    it('getContractState: base is cs.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContractState', type: null } }));
        expect(sql).to.include('cs.id IS NOT NULL');
    });

    it('getSlashEvents: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getPriceSnapshots: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getSlashEvents + type=block: appends AND m.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'block' } }));
        expect(sql).to.include('m.block_index=?');
    });

    it('getCoinpayObligations + type=block: filters on m.block_index (no blocks join exists; b1 would 500)', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCoinpayObligations', type: 'block' } }));
        expect(sql).to.include('m.block_index=?');
        expect(sql).to.not.include('b1.block_index');
    });

    it('getSlashEvents + type=contract: appends AND m.target_contract_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'contract' } }));
        expect(sql).to.include('m.target_contract_index=?');
    });

    it('getSlashEvents + type=address: appends signing_pubkey_id subquery', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'address' } }));
        expect(sql).to.include('signing_pubkey_id');
        expect(sql).to.include('contract_stakes');
    });

    it('getPriceSnapshots + type=pair: appends AND m.coin_pair=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'pair' } }));
        expect(sql).to.include('m.coin_pair=?');
    });

    it('getPriceSnapshots + type=round: appends AND m.round_number=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'round' } }));
        expect(sql).to.include('m.round_number=?');
    });

    it('getPriceSnapshots + type=status: appends AND m.status=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'status' } }));
        expect(sql).to.include('m.status=?');
    });

    it('type=contract on getContracts: appends AND m.contract_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'contract' } }));
        expect(sql).to.include('m.contract_index=?');
    });

    it('type=contract on getContract: appends AND m.action_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContract', type: 'contract' } }));
        expect(sql).to.include('m.action_index=?');
    });

    it('type=contract on getContractState: no extra clause appended', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContractState', type: 'contract' } }));
        // contract_index filter is applied inside the subquery; no outer clause
        expect(sql).to.equal('cs.id IS NOT NULL');
    });

    it('type=address on getCoinpayObligations: appends AND (a1.address=? OR a2.address=?)', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCoinpayObligations', type: 'address' } }));
        expect(sql).to.include('a1.address=?');
        expect(sql).to.include('a2.address=?');
    });
});

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

describe('Database#getQuery (API path)', () => {
    let db;
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

describe('Database#getActionSummaryData: non-SEND actions', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // Same reason as the sibling describe above: getActionData is stubbed here, so
        // the shared-leg prefetch has no reader (see action-preload-parity.test.js).
        sinon.stub(db, '_buildActionPreload').resolves(null);
    });
    afterEach(() => { sinon.restore(); });

    it('copies direct fields from info to details for non-SEND action (line 6070)', async () => {
        sinon.stub(db, 'getActionData').resolves({
            action: 'ISSUE',
            status: 'valid',
            tick: 'XCHAIN',
            source: 'addr1',
            amount: '100',
        });
        const actions = [{ action_index: 50, action: 'ISSUE', block_index: 400, timestamp: 1699000000, tx_hash: 'iss123', tx_index: 3 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].details).to.be.an('object');
        expect(result[0].details.tick).to.equal('XCHAIN');
        expect(result[0].details.source).to.equal('addr1');
        expect(result[0].details.amount).to.equal('100');
    });

    it('details is false when no detailFields exist in info', async () => {
        sinon.stub(db, 'getActionData').resolves({
            action: 'UNKNOWN',
            status: 'invalid',
        });
        const actions = [{ action_index: 99, action: 'UNKNOWN', block_index: 400, timestamp: 1699000000, tx_hash: 'u123', tx_index: 9 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].details).to.be.false;
    });
});

describe('Database#getSearch: broadcast type', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('populates broadcast results when broadcast type matches', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            // Count queries run via Promise.all; identify by query content
            if(q.includes('FROM broadcasts')) return [{ count: 1 }];
            if(q.includes('FROM index_addresses')) return [{ count: 0 }];
            if(q.includes('FROM transactions') && q.includes('count')) return [{ count: 0 }];
            if(q.includes('FROM tokens') && q.includes('count')) return [{ count: 0 }];
            // Data query for broadcast (after count phase)
            if(q.includes('FROM broadcasts') || q.includes('b.message')) return [{ action_index: 100, message: 'hello world', memo: null, status: 'valid' }];
            return [{ count: 0 }];
        });
        const config = makeActionConfig('getSearch', 'broadcast');
        config.data.search = 'hello';
        const [data, , total] = await db.getSearch(config);
        expect(data.totals.broadcasts).to.equal(1);
        expect(total).to.equal(1);
        expect(data.data).to.be.an('array');
        expect(data.data[0]).to.have.property('message', 'hello world');
    });

    it('populates transaction results when transaction type matches', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            // Identify count queries by FROM clause
            if(q.includes('FROM transactions') && q.includes('count')) return [{ count: 2 }];
            if(q.includes('FROM index_addresses') && q.includes('count')) return [{ count: 0 }];
            if(q.includes('FROM broadcasts') && q.includes('count')) return [{ count: 0 }];
            if(q.includes('FROM tokens') && q.includes('count')) return [{ count: 0 }];
            // Data query for transaction
            if(q.includes('t2.hash') && !q.includes('count')) return [{ hash: 'abc123def456' }];
            return [{ count: 0 }];
        });
        const config = makeActionConfig('getSearch', 'transaction');
        config.data.search = 'abc123';
        const [data, , total] = await db.getSearch(config);
        expect(data.totals.transactions).to.equal(2);
        expect(total).to.equal(2);
        expect(data.data[0]).to.have.property('hash', 'abc123def456');
    });
});

describe('Database#getOrderInfoBatch: edit + match loops', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('applies edit results to update order expiration (lines 6514-6522)', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            callN++;
            if(callN === 1) return [{
                action_index: 60n, block_index: 450n, block_time: 1699500000n,
                allow_list: 0n, block_list: 0n,
                give_tick: 'XCHAIN', get_tick: 'BTC',
                give_amount: '100', get_amount: '0.001',
                source: 'addr1', get_address: 'addr2', expiration: 900000,
                memo: null, status: 'valid', order_status: 'open', get_coin: 'BTC'
            }]; // main orders query
            if(callN === 2) return [{
                order_action_index: 60, expiration: 999999, allow_list: null, block_list: null
            }]; // edit results
            if(callN === 3) return [{
                action_index: 60, give_amount: '100', get_amount: '0.001'
            }]; // amounts
            return []; // no matches
        });
        const map = await db.getOrderInfoBatch(cfg(), [60]);
        expect(map[60].expiration).to.equal(999999);
    });

    it('applies match deductions to give_remaining and get_remaining (lines 6561-6585)', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            callN++;
            if(callN === 1) return [{
                action_index: 60n, block_index: 450n, block_time: 1699500000n,
                allow_list: 0n, block_list: 0n,
                give_tick: 'XCHAIN', get_tick: 'BTC',
                give_amount: '100', get_amount: '200',
                source: 'addr1', get_address: 'addr2', expiration: 900000,
                memo: null, status: 'valid', order_status: 'open', get_coin: 'BTC'
            }]; // main
            if(callN === 2) return []; // no edits
            if(callN === 3) return [{ action_index: 60, give_amount: '100', get_amount: '200' }]; // amounts
            // One match where 60 is the GET side: get_action_index=60
            // give_amount deducted from give_remaining, get_amount from get_remaining
            return [{ give_action_index: 999, get_action_index: 60, give_amount: '40', get_amount: '80' }];
        });
        const map = await db.getOrderInfoBatch(cfg(), [60]);
        // give_remaining = 100 - 40 = 60, get_remaining = 200 - 80 = 120
        expect(Number(map[60].give_remaining)).to.equal(60);
        expect(Number(map[60].get_remaining)).to.equal(120);
    });

    it('sets give_remaining and get_remaining on order from remainingMap (line 6583-6585)', async () => {
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            callN++;
            if(callN === 1) return [{
                action_index: 61n, block_index: 451n, block_time: 1699500001n,
                allow_list: 0n, block_list: 0n,
                give_tick: 'XCHAIN', get_tick: 'BTC',
                give_amount: '50', get_amount: '100',
                source: 'addr1', get_address: 'addr2', expiration: 900000,
                memo: null, status: 'valid', order_status: 'open', get_coin: 'BTC'
            }];
            if(callN === 2) return []; // no edits
            if(callN === 3) return [{ action_index: 61, give_amount: '50', get_amount: '100' }];
            return []; // no matches, so give_remaining and get_remaining come from amtResults unchanged
        });
        const map = await db.getOrderInfoBatch(cfg(), [61]);
        expect(Number(map[61].give_remaining)).to.equal(50);
        expect(Number(map[61].get_remaining)).to.equal(100);
    });
});

// Covers bail-out cases and doQuery-stub paths.
describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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

    // Bail-out cases
    it('returns [] for getBalances (bail-out)', async () => {
        const result = await db.getQueryOffsets(qoCfg('getBalances', null, 'next'), false, 10);
        expect(result).to.deep.equal([]);
    });

    it('returns [] for getHolders (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getHolders', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTransaction (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTransaction', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getSearch (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getSearch', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getMarkets (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getMarkets', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getMarket (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getMarket', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTokens with type=token (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTokens', 'token', 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTokens with type=subtoken (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTokens', 'subtoken', 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] when method table is not in actionTables whitelist (bail-out)', async () => {
        const result = await db.getQueryOffsets(qoCfg('getUnknownMethod', null, 'next'), false, 10);
        expect(result).to.deep.equal([]);
    });

    // Type=address: id lookup + where construction
    it('looks up address id and builds source_id where clause for getSends', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 42 }];
            return []; // stop offset query
        });
        const config = qoCfg('getSends', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds double-address where for getSends (source OR destination)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 42 }];
            return [];
        });
        const config = qoCfg('getSends', 'address', 'next', 'addr1');
        await db.getQueryOffsets(config, false, 10);
        expect(db.doQuery.callCount).to.be.greaterThan(0);
    });

    it('builds single address_id where for getCredits', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 5 }];
            return [];
        });
        const config = qoCfg('getCredits', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds coinpay obligations address where (payer OR payee)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 7 }];
            return [];
        });
        const config = qoCfg('getCoinpayObligations', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds history address where (type_id=2 AND id)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 9 }];
            return [];
        });
        const config = qoCfg('getHistory', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds token getOrders/getSwaps double-tick where', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 3 }];
            return [];
        });
        const config = qoCfg('getOrders', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds token getDispensers single-tick where', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 4 }];
            return [];
        });
        const config = qoCfg('getDispensers', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds token getHistory where (type_id=1 AND id)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 6 }];
            return [];
        });
        const config = qoCfg('getHistory', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds default token tick_id where for getIssues', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 8 }];
            return [];
        });
        const config = qoCfg('getIssues', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    // Type=block where clause
    it('builds block_index where for block type', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getSends', 'block', 'next', '500');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    // action=first/last path with doQuery returning rows
    it('action=first: sets offset1 from doQuery result and returns it incremented', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('offset_index')) return [{ offset_index: 1000 }];
            return [];
        });
        const config = qoCfg('getSends', null, 'first', null, { action: 'first' });
        config.data.offset.action = 'first';
        config.data.type = null;
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        // After first action: offset1 = 1000, then offset1++  → 1001
        expect(offset1).to.equal(1001);
    });

    it('action=last (non-block type): executes SQL and returns stop offset', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 500 }]);
        const config = qoCfg('getSends', null, 'last', null);
        config.data.offset = { action: 'last' };
        config.data.type = null;
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'last' };
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    // offset1 provided: stop offset lookup
    it('with offset1 provided and action=next: runs stop offset query', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            // stop-offset query returns offset_index rows
            return Array.from({ length: 11 }, (_, i) => ({ offset_index: 100 - i }));
        });
        const config = qoCfg('getSends', null, 'next', null);
        config.data.offset = { action: 'next', start: 500 };
        config.data.type = null;
        config.data.query = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        const [offset1, offset2] = await db.getQueryOffsets(config, 500, 10);
        // Returned limit+1 rows → offset2 set
        expect(offset2).to.not.be.false;
    });

    it('with offset1 provided and action=prev: runs stop offset query', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            return Array.from({ length: 11 }, (_, i) => ({ offset_index: 200 + i }));
        });
        const config = qoCfg('getSends', null, 'prev', null);
        config.data.offset = { action: 'prev', start: 300 };
        config.data.type = null;
        config.data.query = { limit: 10, length: 10, start: 300, offset: false, total: 50, action: 'prev' };
        const [offset1, offset2] = await db.getQueryOffsets(config, 300, 10);
        expect(offset2).to.not.be.false;
    });

    it('stop offset returns [] when fewer rows than limit+1', async () => {
        sinon.stub(db, 'doQuery').callsFake(async () => [{ offset_index: 50 }]); // only 1 row, limit+1=11
        const config = qoCfg('getSends', null, 'next', null);
        config.data.offset = { action: 'next', start: 500 };
        config.data.type = null;
        config.data.query = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        const [offset1, offset2] = await db.getQueryOffsets(config, 500, 10);
        expect(offset2).to.be.false; // only 1 row returned so offset2 stays false
    });

    // CORRECTED: an untyped getHistory is the ALL-ACTIVITY feed, and it pages over
    // `actions`, not over mappings_actions. The mapping table only carries actions
    // that moved an address/tick ledger, so a boundary computed from it opens the
    // feed below every consensus action newer than the last ledger-moving one. Only
    // the address/token feeds page over the mapping table; see
    // db.history-unmapped-actions.test.js.
    it('getHistory type non-block: uses actions for the stop offset', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getHistory', null, 'next', null);
        config.data.offset = { action: 'next', start: 500 };
        config.data.query = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        const result = await db.getQueryOffsets(config, 500, 10);
        expect(result).to.be.an('array');
        const lastCall = db.doQuery.lastCall;
        if(lastCall){
            expect(lastCall.args[1]).to.not.include('mappings_actions');
            expect(lastCall.args[1]).to.include('a1.action_index as offset_index');
        }
    });

    it('getHistory type=address: still uses mappings_actions for the stop offset', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 7 }];
            return [];
        });
        const config = qoCfg('getHistory', 'address', 'next', 'addr1');
        config.data.offset = { action: 'next', start: 500 };
        config.data.query = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        await db.getQueryOffsets(config, 500, 10);
        const lastCall = db.doQuery.lastCall;
        if(lastCall) expect(lastCall.args[1]).to.include('mappings_actions');
    });

    it('getFiles type=token: uses mappings_files for stop offset', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 2 }];
            return [];
        });
        const config = qoCfg('getFiles', 'token', 'next', 'XCHAIN');
        config.data.offset = { action: 'next', start: 500 };
        config.data.query = { limit: 10, length: 10, start: 500, offset: false, total: 50, action: 'next' };
        const result = await db.getQueryOffsets(config, 500, 10);
        expect(result).to.be.an('array');
    });

    it('a BLOCKS listing with offset1 + action=next: calculates offset2 via bcsub', async () => {
        // CORRECTED 2026-08-27: these three pinned the defect, not the behaviour. They are
        // line-coverage tests ("line 770", "lines 688-697") that reached the block-index
        // branch by passing a SENDS listing with type='block' - the FILTER axis - and then
        // asserted the branch they had reached. A sends listing is a listing of ACTIONS
        // however it is filtered, so paging it over the blocks table hands the main query a
        // block_index where it expects an action_index. Keying on that axis is exactly what
        // left /{COIN}/blocks answering 500 on every coin for five months. The branch is now
        // keyed on the TABLE being listed, so these exercise it through getBlocks.
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getBlocks', 'block', 'next', '500');
        config.data.offset = { action: 'next' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'next' };
        const [offset1, offset2] = await db.getQueryOffsets(config, 850000, 10);
        // offset2 = bcsub(bcsub(850000,1),10) = 849989
        expect(Number(offset2)).to.equal(849989);
    });

    it('a BLOCKS listing with offset1 + action=last: uses bcadd path', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getBlocks', 'block', 'last', '500');
        config.data.offset = { action: 'last' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'last' };
        const [offset1, offset2] = await db.getQueryOffsets(config, 850000, 10);
        // offset2 = bcsub(bcadd(850000,1),10) = 849991
        expect(Number(offset2)).to.equal(849991);
    });

    it('getFiles type=token + action=first: uses mappings_files SQL (lines 724-736)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 2 }];
            // getFiles + token + first: the first/last SQL block runs first, then stops
            if(q.includes('mappings_files') || q.includes('offset_index')) return [{ offset_index: 500 }];
            return [];
        });
        const config = qoCfg('getFiles', 'token', 'first', 'XCHAIN');
        config.data.offset = { action: 'first' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('getTokens + action=first: uses tokens table SQL (lines 698-710)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 300 }]);
        const config = qoCfg('getTokens', null, 'first', null);
        config.data.offset = { action: 'first' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        expect(offset1).to.equal(301); // 300 + 1 for first action
    });

    it('getHistory + action=first: uses mappings_actions SQL (lines 711-723)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 700 }]);
        const config = qoCfg('getHistory', null, 'first', null);
        config.data.offset = { action: 'first' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        expect(offset1).to.equal(701); // 700 + 1
    });
});

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

describe('Database#getQuery (Explorer path)', () => {
    let db;
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

describe('Database#getQueryOffsets: remaining branches', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
        const queries = db.doQuery.args.map(a => a[1] || '');
        const stopQuery = queries.find(q => q.includes('offset_index') && q.includes('orders m'));
        expect(stopQuery).to.include('t1.source_id');
    });

    it('a BLOCKS listing + null search + action=first: uses the blocks table', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 850000 }]);
        const config = qoCfg('getBlocks', 'block', 'first', null);
        config.data.search = null;
        config.data.offset = { action: 'first' };
        config.data.query  = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const result = await db.getQueryOffsets(config, false, 10);
        expect(db.doQuery.firstCall.args[1]).to.include('blocks b1');
        expect(result).to.be.an('array');
    });
});

// Batch tests for many action types.
describe('Database#getActionData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // Helper: build a minimal row for most action types
    function baseRow(extra = {}) {
        return {
            action: extra.action || 'SEND',
            action_format: 0,
            action_index: 100,
            source: 'addr1',
            block_index: 500,
            timestamp: 1700000000,
            tx_hash: 'abc123',
            tx_index: 1,
            memo: null,
            status: 'valid',
            ...extra
        };
    }

    // Helper: check if a query references a given table name (handles newlines)
    function queryHasTable(q, table) {
        if(!q) return false;
        return new RegExp(table, 'i').test(q);
    }

    // Helper: stub common doQuery dispatch and stubs for fee/tx
    function stubForType(db, type, mainRow, extra = {}) {
        sinon.stub(db, 'getActionType').resolves(type);
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            // credits/debits/escrows always resolve empty
            if(q && (queryHasTable(q,'\\bcredits\\b') || queryHasTable(q,'\\bdebits\\b') || queryHasTable(q,'\\bescrows\\b'))) return [];
            // Extra routing provided by caller
            for(const [pattern, rows] of Object.entries(extra)){
                if(q && q.includes(pattern)) return rows;
            }
            if(mainRow) return [mainRow];
            return [];
        });
    }

    it('returns cached result on second call (LRU cache, line 3918-3920)', async () => {
        // Stubbing every query to `[]` would model a state that cannot happen:
        // getActionType found the action, so its `actions` row exists and
        // deblankBaseline returns one, yet the response would carry no
        // `action_index`, making it indistinguishable from a NOT-FOUND, which is
        // deliberately not cached. Give it a real main row so it pins what it
        // means: the second read is served from the LRU.
        stubForType(db, 'SEND', { action: 'SEND', action_index: 100 });
        const config = cfg();
        const result1 = await db.getActionData(config, 100);
        const callCount1 = db.doQuery.callCount;
        const result2 = await db.getActionData(config, 100);
        expect(db.doQuery.callCount).to.equal(callCount1);
    });

    it('returns base data when type is null (no action-specific queries)', async () => {
        sinon.stub(db, 'getActionType').resolves(null);
        const config = cfg();
        const result = await db.getActionData(config, 9999);
        expect(result).to.have.property('credits', null);
        expect(result).to.have.property('debits', null);
        expect(result).to.have.property('escrows', null);
        expect(result).to.have.property('fee', null);
    });

    it('ADDRESS action: skips credits/debits/escrows (lines 3944-3973)', async () => {
        stubForType(db, 'ADDRESS', baseRow({ action: 'ADDRESS' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.credits).to.be.null;
        expect(result.debits).to.be.null;
        expect(result.escrows).to.be.null;
        expect(result.source).to.equal('addr1');
    });

    it('AIRDROP action: returns airdrop data (lines 3975-4004)', async () => {
        stubForType(db, 'AIRDROP', baseRow({ action: 'AIRDROP', tick: 'XCHAIN', amount: '100', list_action_index: 5 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('AIRDROP');
        expect(result.tick).to.equal('XCHAIN');
    });

    it('BROADCAST action: skips credits/debits/escrows (lines 4041-4070)', async () => {
        stubForType(db, 'BROADCAST', baseRow({ action: 'BROADCAST', message: 'hello', value: '100' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.credits).to.be.null;
        expect(result.debits).to.be.null;
        expect(result.escrows).to.be.null;
        expect(result.message).to.equal('hello');
    });

    it('COINPAY action: returns coinpay settlement data from the coinpays table', async () => {
        stubForType(db, 'COINPAY', baseRow({ action: 'COINPAY', obligation_action_index: 42, coin_amount: '0.5', txid: 'deadbeef', vout: 1 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('COINPAY');
        expect(result.obligation_action_index).to.equal(42);
        expect(result.coin_amount).to.equal('0.5');
        expect(result.txid).to.equal('deadbeef');
        // The type branch must actually query the coinpays table
        const queried = db.doQuery.getCalls().some(c => /FROM\s+coinpays\b/i.test(c.args[1]));
        expect(queried).to.be.true;
    });

    it('COINPAY_EXPIRE action: returns expiry data from the coinpay_expires table', async () => {
        stubForType(db, 'COINPAY_EXPIRE', baseRow({ action: 'COINPAY_EXPIRE', obligation_action_index: 42 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('COINPAY_EXPIRE');
        expect(result.obligation_action_index).to.equal(42);
        const queried = db.doQuery.getCalls().some(c => /FROM\s+coinpay_expires\b/i.test(c.args[1]));
        expect(queried).to.be.true;
    });

    it('DESTROY action: returns destroy data (lines 4105-4133)', async () => {
        stubForType(db, 'DESTROY', baseRow({ action: 'DESTROY', tick: 'XCHAIN', amount: '50' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DESTROY');
        expect(result.tick).to.equal('XCHAIN');
    });

    it('DISPENSER action: includes state object and skips get_remaining (lines 4135-4218)', async () => {
        const row = baseRow({ action: 'DISPENSER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', give_escrow: '100', expiration: 0, allow_list: null, block_list: null, current_status: 'open' });
        sinon.stub(db, 'getActionType').resolves('DISPENSER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            // query2 = order_edits for DISPENSER
            if(q && q.includes('dispenser_edits') && !q.includes('order')) return [];
            // query3 = dispenses
            if(q && q.includes('dispenses')) return [];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('state');
        expect(result.state).to.have.property('give_remaining');
        expect(result.state).not.to.have.property('get_remaining');
    });

    it('DISPENSER with edits: refill escrow adds to give_remaining, list edit applies', async () => {
        const row = baseRow({ action: 'DISPENSER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', give_escrow: '100', expiration: 0, allow_list: null, block_list: null, current_status: 'open' });
        // A refill edit (give_escrow) that also sets allow_list. dispenser_action_index
        // keys the row to its dispenser in the shared escrow derivation.
        const editRow = { dispenser_action_index: 100, give_escrow: '50', expiration: null, allow_list: 'someList', block_list: null, block_time: 0 };
        sinon.stub(db, 'getActionType').resolves('DISPENSER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        // getMaxBlockTime returns a value well above block_time(0)+DISPENSER_LIST_DELAY(3600) so active=true
        sinon.stub(db, 'getMaxBlockTime').resolves(9999999);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (queryHasTable(q, '\\bcredits\\b') || queryHasTable(q, '\\bdebits\\b') || queryHasTable(q, '\\bescrows\\b'))) return [];
            if(q && q.includes('dispenser_edits')) return [editRow];
            if(q && q.includes('dispenses')) return [];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        // give_remaining should have had editRow.give_escrow (50) added to the initial give_amount (100)
        expect(Number(result.state.give_remaining)).to.be.greaterThan(100);
        expect(result.state.allow_list).to.equal('someList');
    });

    it('DISPENSER with dispenses: give_remaining reduced by every payout', async () => {
        const row = baseRow({ action: 'DISPENSER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', give_escrow: '100', expiration: 0, allow_list: null, block_list: null, current_status: 'open' });
        const dispenseRow = { dispenser_action_index: 100, give_amount: '10' };
        sinon.stub(db, 'getActionType').resolves('DISPENSER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (queryHasTable(q, '\\bcredits\\b') || queryHasTable(q, '\\bdebits\\b') || queryHasTable(q, '\\bescrows\\b'))) return [];
            if(q && q.includes('dispenser_edits')) return [];
            if(q && q.includes('dispenses')) return [dispenseRow];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        // give_remaining should have been reduced by 10 (from initial 100)
        expect(Number(result.state.give_remaining)).to.equal(90);
    });

    it('DISPENSE action: returns dispense data (lines 4396-4433)', async () => {
        stubForType(db, 'DISPENSE', baseRow({ action: 'DISPENSE', dispenser_action_index: 70, give_tick: 'XCHAIN', give_amount: '10' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DISPENSE');
    });

    it('ISSUE action: returns issue data (lines 4502-4554)', async () => {
        stubForType(db, 'ISSUE', baseRow({ action: 'ISSUE', tick: 'XCHAIN', max_supply: '21000000', max_mint: '100', decimals: 8 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.tick).to.equal('XCHAIN');
        expect(result.max_supply).to.equal('21000000');
    });

    it('MINT action: returns mint data (lines 4671-4701)', async () => {
        stubForType(db, 'MINT', baseRow({ action: 'MINT', tick: 'XCHAIN', amount: '100' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('MINT');
        expect(result.amount).to.equal('100');
    });

    it('ORDER action: includes state + get/give remaining (lines 4703-4781)', async () => {
        const row = baseRow({ action: 'ORDER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', give_price: '0.00001', get_price: '100000', expiration: 900000, allow_list: null, block_list: null, current_status: 'open' });
        sinon.stub(db, 'getActionType').resolves('ORDER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('order_edits')) return [];
            if(q && q.includes('order_matches')) return [];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('state');
        expect(result.state).to.have.property('get_remaining');
        expect(result.state).to.have.property('give_remaining');
    });

    it('SEND action: includes sends array from query2 (lines 4929-4966)', async () => {
        const mainRow = baseRow({ action: 'SEND' });
        const sendRow = { destination: 'addr2', tick: 'XCHAIN', amount: '100', status: 'valid', memo: null };
        sinon.stub(db, 'getActionType').resolves('SEND');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            // query2 selects 'destination' field; main query selects 'action_index'
            if(q && q.includes('destination')) return [sendRow];  // query2
            return [mainRow]; // main query, credit/debit/escrow fallthrough
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('sends');
        expect(result.sends).to.be.an('array').with.lengthOf(1);
        expect(result.sends[0].tick).to.equal('XCHAIN');
    });

    it('SLEEP action: returns sleep data (lines 4968-4997)', async () => {
        stubForType(db, 'SLEEP', baseRow({ action: 'SLEEP', resume_block: 600 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.resume_block).to.equal(600);
    });

    it('SWEEP action: includes issues from query2 (lines 5211-5257)', async () => {
        const mainRow = baseRow({ action: 'SWEEP' });
        sinon.stub(db, 'getActionType').resolves('SWEEP');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('FROM issues')) return [{ tick: 'XCHAIN', amount: '100' }];
            return [mainRow];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('issues');
        expect(result.issues).to.be.an('array');
    });

    it('ATTEST action: expands validator_signatures JSON (lines 5260-5302)', async () => {
        const sigs = JSON.stringify([{ validator: 'v1', sig: 'abc' }]);
        stubForType(db, 'ATTEST', baseRow({ action: 'ATTEST', validator_signatures: sigs, attest_version: 1 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('signatures');
        expect(result.signatures).to.be.an('array').with.lengthOf(1);
        expect(result.signatures[0].validator).to.equal('v1');
        expect(result).not.to.have.property('validator_signatures');
    });

    it('ATTEST action: handles missing validator_signatures gracefully', async () => {
        stubForType(db, 'ATTEST', baseRow({ action: 'ATTEST', attest_version: 0 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.signatures).to.deep.equal([]);
    });

    it('ATTEST action: handles invalid JSON in validator_signatures', async () => {
        stubForType(db, 'ATTEST', baseRow({ action: 'ATTEST', validator_signatures: 'bad json', attest_version: 1 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.signatures).to.deep.equal([]);
    });

    it('PRICE action: expands pairs_json and sigs_json (lines 5551-5640)', async () => {
        const pairs = JSON.stringify([{ pair: 'BTC/USD', price: '50000' }]);
        const sigs  = JSON.stringify([{ validator: 'v1', sig: 'xyz' }]);
        stubForType(db, 'PRICE', baseRow({ action: 'PRICE', pairs_json: pairs, sigs_json: sigs }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.pairs).to.be.an('array').with.lengthOf(1);
        expect(result.signatures).to.be.an('array').with.lengthOf(1);
        expect(result).not.to.have.property('pairs_json');
        expect(result).not.to.have.property('sigs_json');
    });

    it('PRICE action: handles missing/invalid JSON gracefully', async () => {
        stubForType(db, 'PRICE', baseRow({ action: 'PRICE', pairs_json: 'bad', sigs_json: null }));
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('action', 'PRICE');
    });

    it('STAKE action: returns stake data (lines 5303-5338)', async () => {
        stubForType(db, 'STAKE', baseRow({ action: 'STAKE', signing_pubkey: 'deadbeef', amount: '1000' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.signing_pubkey).to.equal('deadbeef');
    });

    it('UNSTAKE action: returns unstake data (lines 5340-5373)', async () => {
        stubForType(db, 'UNSTAKE', baseRow({ action: 'UNSTAKE', signing_pubkey: 'deadbeef', amount: '500' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('UNSTAKE');
    });

    it('DELEGATE action: returns delegate data (lines 5375-5408)', async () => {
        stubForType(db, 'DELEGATE', baseRow({ action: 'DELEGATE', tick: 'XCHAIN', amount: '100' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DELEGATE');
    });

    it('COLLECT action: returns collect data (lines 5410-5434)', async () => {
        stubForType(db, 'COLLECT', baseRow({ action: 'COLLECT', tick: 'XCHAIN', amount: '25' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('COLLECT');
    });

    it('DEPLOY action: returns deploy data (lines 5436-5464)', async () => {
        stubForType(db, 'DEPLOY', baseRow({ action: 'DEPLOY', code_hash: 'c0dehash', contract_index: 5 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.code_hash).to.equal('c0dehash');
    });

    it('DEPLOY v4 chunk carrier: returns chunk data from deploy_chunks (action_format===4 branch)', async () => {
        // v4 carriers share the DEPLOY action name but live in deploy_chunks (one base64
        // code slice each); getActionData picks the detail query by action_format. The
        // base row carries action_format:4 but no chunk fields, so the assertions only
        // pass if the action_format probe actually drove the v4 branch.
        stubForType(db, 'DEPLOY', baseRow({ action: 'DEPLOY', action_format: 4 }), {
            'deploy_chunks': [ baseRow({ action: 'DEPLOY', action_format: 4, code_hash: 'c0dehash', chunk_index: 2, total_chunks: 5 }) ]
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.action_format).to.equal(4);
        expect(result.code_hash).to.equal('c0dehash');
        expect(result.chunk_index).to.equal(2);
        expect(result.total_chunks).to.equal(5);
    });

    it('EXECUTE action: returns execution data (lines 5466-5496)', async () => {
        stubForType(db, 'EXECUTE', baseRow({ action: 'EXECUTE', method_name: 'transfer', gas_used: 1000, contract_index: 5 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.method_name).to.equal('transfer');
    });

    it('DEPOSIT action: returns deposit data (lines 5498-5526)', async () => {
        stubForType(db, 'DEPOSIT', baseRow({ action: 'DEPOSIT', tick: 'XCHAIN', amount: '100', contract_index: 5 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DEPOSIT');
    });

    it('WITHDRAW action: returns withdraw data (lines 5498-5526)', async () => {
        stubForType(db, 'WITHDRAW', baseRow({ action: 'WITHDRAW', tick: 'XCHAIN', amount: '100', contract_index: 5 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('WITHDRAW');
    });

    it('UNKNOWN action: returns unknown data with invalid status (lines 5528-5549)', async () => {
        stubForType(db, 'UNKNOWN', baseRow({ action: 'UNKNOWN', status: 'invalid' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.status).to.equal('invalid');
    });

    it('SWAP action: includes state object (lines 4999-5063)', async () => {
        const row = baseRow({ action: 'SWAP', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', current_status: 'open', expiration: 0, allow_list: null, block_list: null });
        sinon.stub(db, 'getActionType').resolves('SWAP');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('swap_edits')) return [];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('state');
        expect(result.state).to.have.property('give_remaining');
    });

    it('ORDER_MATCH action: returns match data (lines 4896-4927)', async () => {
        stubForType(db, 'ORDER_MATCH', baseRow({ action: 'ORDER_MATCH', forward_action_index: 60, backward_action_index: 61, give_amount: '100', get_amount: '0.001' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('ORDER_MATCH');
    });

    it('SWAP_MATCH action: returns match data (lines 5178-5209)', async () => {
        stubForType(db, 'SWAP_MATCH', baseRow({ action: 'SWAP_MATCH', forward_action_index: 60, backward_action_index: 61 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('SWAP_MATCH');
    });

    it('DIVIDEND action: returns dividend data (lines 4435-4464)', async () => {
        stubForType(db, 'DIVIDEND', baseRow({ action: 'DIVIDEND', dividend_tick: 'XCHAIN', tick: 'PEPE', amount: '1000' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DIVIDEND');
    });

    it('FILE action: returns file data (lines 4466-4500)', async () => {
        stubForType(db, 'FILE', baseRow({ action: 'FILE', name: 'test.txt', title: 'Test File' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.name).to.equal('test.txt');
    });

    it('LINK action: returns link data (lines 4556-4587)', async () => {
        stubForType(db, 'LINK', baseRow({ action: 'LINK', coin1: 'BTC', coin2: 'LTC', coin1_action_index: 50, coin2_action_index: 51 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.coin1).to.equal('BTC');
    });

    it('MESSAGE action: returns message data (lines 4639-4669)', async () => {
        stubForType(db, 'MESSAGE', baseRow({ action: 'MESSAGE', encryption_method: 'ECIES', plaintext_message: 'hello' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.encryption_method).to.equal('ECIES');
    });

    it('CALLBACK action: returns callback data (lines 4072-4103)', async () => {
        stubForType(db, 'CALLBACK', baseRow({ action: 'CALLBACK', callback_tick: 'NEWTOKEN', callback_amount: '100' }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.callback_tick).to.equal('NEWTOKEN');
    });

    it('LIST action: populates list and edits from query2/query3 (lines 4589-4637)', async () => {
        const mainRow = baseRow({ action: 'LIST', type: 1 }); // type=1 → tick list
        sinon.stub(db, 'getActionType').resolves('LIST');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            // query2 = FROM list_items l1
            if(q && q.includes('list_items')) return [{ tick: 'XCHAIN', address: null }, { tick: 'PEPE', address: null }];
            // query3 = FROM list_edits l1
            if(q && q.includes('list_edits')) return [{ tick: 'NEWTOKEN', address: null, status: 'valid' }];
            return [mainRow];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('list');
        expect(result.list).to.include('XCHAIN');
        expect(result).to.have.property('edits');
    });

    it('BATCH action: populates actions array from sub-getActionData calls (lines 4006-4039)', async () => {
        const mainRow = baseRow({ action: 'BATCH' });
        sinon.stub(db, 'getActionType').resolves('BATCH');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        let callN = 0;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            callN++;
            // query2 = sub-actions in batch
            if(callN === 2) return [{ action_index: 101 }, { action_index: 102 }];
            return [mainRow];
        });
        // Stub recursive getActionData calls for sub-actions
        const origGetActionData = db.getActionData.bind(db);
        db.getActionData = async (config, ai) => {
            if(ai === 100) return origGetActionData(config, ai);
            return { action: 'SEND', action_index: ai, status: 'valid' };
        };
        const result = await db.getActionData(cfg(), 100);
        expect(result).to.have.property('actions');
        expect(result.actions).to.be.an('array').with.lengthOf(2);
    });

    it('ORDER action: deducts match amounts from state.give/get_remaining (line 5718-5729)', async () => {
        const row = baseRow({ action: 'ORDER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '200', give_price: '0.00001', get_price: '100000', expiration: 0, allow_list: null, block_list: null, current_status: 'open' });
        sinon.stub(db, 'getActionType').resolves('ORDER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('order_edits')) return [];
            // query3 = order_matches: return one match where 100 is get side
            if(q && q.includes('order_matches')) return [{ give_action_index: 999, get_action_index: 100, give_amount: '40', get_amount: '80' }];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        // give_remaining = 100 - 40 = 60, get_remaining = 200 - 80 = 120
        expect(result.state.give_remaining).to.equal('60');
        expect(result.state.get_remaining).to.equal('120');
    });

    it('ORDER_CANCEL action: returns cancel data (lines 4783-4820)', async () => {
        stubForType(db, 'ORDER_CANCEL', baseRow({ action: 'ORDER_CANCEL', order_action_index: 60 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.order_action_index).to.equal(60);
    });

    it('ORDER_EDIT action: returns edit data (lines 4822-4863)', async () => {
        stubForType(db, 'ORDER_EDIT', baseRow({ action: 'ORDER_EDIT', order_action_index: 60, expiration: 999999 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.expiration).to.equal(999999);
    });

    it('ORDER_EXPIRE action: returns expire data (lines 4865-4893)', async () => {
        stubForType(db, 'ORDER_EXPIRE', baseRow({ action: 'ORDER_EXPIRE', order_action_index: 60 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('ORDER_EXPIRE');
    });

    it('SWAP_CANCEL action: returns cancel data (lines 5066-5103)', async () => {
        stubForType(db, 'SWAP_CANCEL', baseRow({ action: 'SWAP_CANCEL', swap_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.swap_action_index).to.equal(70);
    });

    it('SWAP_EDIT action: returns edit data (lines 5105-5145)', async () => {
        stubForType(db, 'SWAP_EDIT', baseRow({ action: 'SWAP_EDIT', swap_action_index: 70, expiration: 999999 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('SWAP_EDIT');
    });

    it('SWAP_EXPIRE action: returns expire data (lines 5147-5176)', async () => {
        stubForType(db, 'SWAP_EXPIRE', baseRow({ action: 'SWAP_EXPIRE', swap_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('SWAP_EXPIRE');
    });

    it('DISPENSER_CLOSE action: returns close data (lines 4220-4258)', async () => {
        stubForType(db, 'DISPENSER_CLOSE', baseRow({ action: 'DISPENSER_CLOSE', dispenser_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DISPENSER_CLOSE');
    });

    it('DISPENSER_CANCEL action: returns cancel data (lines 4260-4304)', async () => {
        stubForType(db, 'DISPENSER_CANCEL', baseRow({ action: 'DISPENSER_CANCEL', dispenser_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DISPENSER_CANCEL');
    });

    it('DISPENSER_EDIT action: returns edit data (lines 4306-4354)', async () => {
        stubForType(db, 'DISPENSER_EDIT', baseRow({ action: 'DISPENSER_EDIT', dispenser_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DISPENSER_EDIT');
    });

    it('DISPENSER_EXPIRE action: returns expire data (lines 4356-4394)', async () => {
        stubForType(db, 'DISPENSER_EXPIRE', baseRow({ action: 'DISPENSER_EXPIRE', dispenser_action_index: 70 }));
        const result = await db.getActionData(cfg(), 100);
        expect(result.action).to.equal('DISPENSER_EXPIRE');
    });

    it('credits are populated when credits query returns rows', async () => {
        sinon.stub(db, 'getActionType').resolves('SEND');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        const creditRow = { address: 'addr1', tick: 'XCHAIN', amount: '100' };
        const mainRow = baseRow({ action: 'SEND' });
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && queryHasTable(q, '\\bcredits\\b')) return [creditRow];
            if(q && (queryHasTable(q, '\\bdebits\\b') || queryHasTable(q, '\\bescrows\\b'))) return [];
            if(q && q.includes('destination')) return []; // SEND query2
            return [mainRow];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.credits).to.be.an('array').with.lengthOf(1);
        expect(result.credits[0].tick).to.equal('XCHAIN');
    });

    it('debits are populated when debits query returns rows', async () => {
        sinon.stub(db, 'getActionType').resolves('MINT');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        const debitRow = { address: 'addr1', tick: 'XCHAIN', amount: '1' };
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && queryHasTable(q, '\\bdebits\\b')) return [debitRow];
            if(q && (queryHasTable(q, '\\bcredits\\b') || queryHasTable(q, '\\bescrows\\b'))) return [];
            return [baseRow({ action: 'MINT', tick: 'XCHAIN', amount: '100' })];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.debits).to.be.an('array').with.lengthOf(1);
        expect(result.debits[0].tick).to.equal('XCHAIN');
    });

    it('escrows are populated when escrows query returns rows', async () => {
        sinon.stub(db, 'getActionType').resolves('ORDER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        const escrowRow = { address: 'addr1', tick: 'XCHAIN', amount: '100' };
        const row = baseRow({ action: 'ORDER', give_tick: 'XCHAIN', get_tick: 'BTC', give_amount: '100', get_amount: '0.001', current_status: 'open', expiration: 0, allow_list: null, block_list: null });
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && queryHasTable(q, '\\bescrows\\b')) return [escrowRow];
            if(q && (queryHasTable(q, '\\bcredits\\b') || queryHasTable(q, '\\bdebits\\b'))) return [];
            if(q && q.includes('order_edits')) return [];
            if(q && q.includes('order_matches')) return [];
            return [row];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.escrows).to.be.an('array').with.lengthOf(1);
    });

    it('fee is populated when getActionFeeData returns a row', async () => {
        const feeRow = { tick: 'XCHAIN', amount: '1', method: 'standard' };
        sinon.stub(db, 'getActionType').resolves('SEND');
        sinon.stub(db, 'getActionFeeData').resolves(feeRow);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('FROM sends')) return [];
            return [baseRow({ action: 'SEND' })];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.fee).to.deep.equal(feeRow);
    });

    it('tx_data is populated when getTransactionData returns a row', async () => {
        sinon.stub(db, 'getActionType').resolves('SEND');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        const txRow = { data: 'deadbeef', fee: 1000 };
        sinon.stub(db, 'getTransactionData').resolves(txRow);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && (q.includes('FROM credits') || q.includes('FROM debits') || q.includes('FROM escrows'))) return [];
            if(q && q.includes('FROM sends')) return [];
            return [baseRow({ action: 'SEND', tx_hash: 'abc123' })];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(result.tx_data).to.equal('deadbeef');
    });
});

describe('Database#getContractDelegations', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractDelegations(makeActionConfig('getContractDelegations'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_delegations" with activation/deactivation bounds', async () => {
        const db = makeDb();
        const [query] = await db.getContractDelegations(makeActionConfig('getContractDelegations'));
        expect(query).to.include('contract_delegations m');
        expect(query).to.include('m.target_contract_index');
        expect(query).to.include('m.activation_block');
        expect(query).to.include('m.deactivation_block');
    });
});

// Capability UNSTAKE v0.
describe('Database#getUnstakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getUnstakes(makeActionConfig('getUnstakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "unstakes" with amount + cooldown, ordered by m.action_index', async () => {
        const db = makeDb();
        const [query] = await db.getUnstakes(makeActionConfig('getUnstakes'));
        expect(query).to.include('unstakes m');
        expect(query).to.include('m.amount');
        expect(query).to.include('m.cooldown_end_block');
        expect(query).to.include('ORDER BY m.action_index');
    });

    // A ROLLCALL eviction writes an unstakes row with tx_index NULL (the indexer,
    // not a holder, wrote it - no broadcast transaction exists behind it). Joining
    // blocks off t1.block_index (a transaction that will never exist for this row)
    // drops the row from an INNER join it can never satisfy; a1.block_index is
    // NOT NULL on every action, synthetic or not, so that join stays INNER while
    // transactions degrades to LEFT so a NULL t1 keeps the row instead of erasing it.
    it('joins blocks off a1.block_index (INNER) and transactions off a1.tx_index (LEFT), in both the rows and count queries', async () => {
        const db = makeDb();
        const [query, , count] = await db.getUnstakes(makeActionConfig('getUnstakes'));
        for(const q of [query, count]){
            expect(q).to.include('INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)');
            expect(q).to.include('LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            // The pre-fix shape joined transactions INNER off a1.tx_index and then
            // chained blocks off t1.block_index; a synthetic row with tx_index NULL
            // satisfies neither and vanishes. Guard against that pattern coming back.
            expect(q).to.not.include('INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            expect(q).to.not.include('b1.block_index=t1.block_index');
        }
    });
});

// DELEGATE v2/v3 key revoke.
describe('Database#getStakeKeyRevocations', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getStakeKeyRevocations(makeActionConfig('getStakeKeyRevocations'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "stake_key_revocations" with the revoked key + deactivation block', async () => {
        const db = makeDb();
        const [query] = await db.getStakeKeyRevocations(makeActionConfig('getStakeKeyRevocations'));
        expect(query).to.include('stake_key_revocations m');
        expect(query).to.include('a3.pubkey as signing_pubkey');
        expect(query).to.include('m.deactivation_block');
    });
});

// COLLECT validator reward claim.
describe('Database#getCollects', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCollects(makeActionConfig('getCollects'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "reward_claims" with the claimed amount', async () => {
        const db = makeDb();
        const [query] = await db.getCollects(makeActionConfig('getCollects'));
        expect(query).to.include('reward_claims m');
        expect(query).to.include('m.amount');
        expect(query).to.include('ORDER BY m.action_index');
    });
});

// SLASH equivocation bond-burn, id-keyed.
describe('Database#getCapabilitySlashEvents', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCapabilitySlashEvents(makeActionConfig('getCapabilitySlashEvents', 'pubkey'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "capability_slash_events" with slash_action_index, ordered by m.id', async () => {
        const db = makeDb();
        const [query] = await db.getCapabilitySlashEvents(makeActionConfig('getCapabilitySlashEvents', 'pubkey'));
        expect(query).to.include('capability_slash_events m');
        expect(query).to.include('m.slash_action_index');
        expect(query).to.include('m.capability');
        expect(query).to.include('ORDER BY m.id');
    });
});

// User PRICE v1, hub-mirrored, id-keyed.
describe('Database#getOraclePrices', () => {
    // oracle_prices is hub-mirrored, same posture as price_snapshots and
    // cross_chain_matches: served only from the mandatory co-located hub DB.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "oracle_prices" with tick/fiat/value, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(query).to.include('oracle_prices m');
        expect(query).to.include('m.tick');
        expect(query).to.include('m.fiat');
        expect(query).to.include('m.value');
        expect(query).to.include('ORDER BY m.id');
    });

    it('checkpoint hub DB configured -> database-qualifies oracle_prices (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(query).to.include('`XChain_Hub`.oracle_prices m');
        expect(count).to.include('`XChain_Hub`.oracle_prices m');
    });

    it('no checkpoint hub DB -> fails loud (no silent empty local mirror)', async () => {
        const db = makeDb();
        let err = null;
        try { await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.include('oracle_prices');
    });

    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getCrossChainMatches', () => {
    // cross_chain_matches is hub-mirrored and served only from the mandatory co-located
    // hub DB. These structural tests configure that hub DB so the query builds;
    // the "no hub DB → fail loud" behavior is covered by its own test below.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query selects both legs and the quorum proof from "cross_chain_matches"', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('cross_chain_matches m');
        expect(query).to.include('m.match_id');
        expect(query).to.include('m.a_action_index');
        expect(query).to.include('m.b_action_index');
        expect(query).to.include('m.validator_signatures');
        expect(query).to.include('m.snapshot_block');
    });

    it('ORDER BY uses m.id (mirror cursor, no action_index)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('ORDER BY m.id');
    });

    it('no checkpoint hub DB → fails loud (no silent local-mirror fallback)', async () => {
        const db = makeDb();
        // checkpointDb is empty by default. The hub-mirrored cross_chain_matches table is
        // never replicated by xchain-sync, so a serving node MUST read it from the co-located
        // hub DB. Without one, getCrossChainMatches throws instead of serving stale local rows.
        let err = null;
        try { await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('checkpoint hub DB configured → database-qualifies to the hub table + network filter (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        const [query, args, count] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('`XChain_Hub`.cross_chain_matches m');
        expect(query).to.include('m.network = ?');
        expect(count).to.include('`XChain_Hub`.cross_chain_matches m');
        expect(count).to.include('m.network = ?');
        // type defaults to 'address' (no type filter `?`), so args = [network] only.
        expect(args).to.deep.equal(['mainnet']);
    });

    it('redirect with a type filter → args order is [search, network]', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        // type='status' adds one `?` (m.status=?) to sql.where.data, bound to config.data.search,
        // so the network `?` must bind AFTER it.
        const [, args] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches', 'status'));
        expect(args).to.deep.equal(['addr1', 'mainnet']);
    });

    it('rejects an unsafe hub DB identifier by failing loud (no local-mirror fallback)', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        // An unsafe configured identifier is a misconfiguration, not a reason to silently
        // serve the stale local mirror: throw rather than fall back.
        let err = null;
        try { await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getCrossChainSettlements', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCrossChainSettlements(makeActionConfig('getCrossChainSettlements'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "cross_chain_settlements" joined to blocks for the timestamp', async () => {
        const db = makeDb();
        const [query] = await db.getCrossChainSettlements(makeActionConfig('getCrossChainSettlements'));
        expect(query).to.include('cross_chain_settlements m');
        expect(query).to.include('m.match_id');
        expect(query).to.include('m.local_action_index');
        expect(query).to.include('b1.block_time as timestamp');
    });
});

// Hub operational-state pages (p2p_peers/consensus_state/configs/telemetry_pings) are
// served ONLY from the mandatory co-located hub DB, same as the governance and
// cross-chain mirrors. These structural tests configure that hub DB so the query builds;
// the "no hub DB -> fail loud" behavior gets one shared assertion below.
const HUB_OPS = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

describe('Database#getPeers', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getPeers(makeActionConfig('getPeers', 'validator'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "p2p_peers" with addr/validator_id/is_seed, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query, , count] = await db.getPeers(makeActionConfig('getPeers', 'validator'));
        expect(query).to.include('`XChain_Hub`.p2p_peers m');
        expect(query).to.include('m.addr');
        expect(query).to.include('m.validator_id');
        expect(query).to.include('m.is_seed');
        expect(query).to.include('ORDER BY m.id');
        expect(count).to.include('`XChain_Hub`.p2p_peers m');
    });

    it('no checkpoint hub DB -> fails loud (no local-mirror fallback)', async () => {
        const db = makeDb();
        let err = null;
        try { await db.getPeers(makeActionConfig('getPeers')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});

describe('Database#getConsensusState', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getConsensusState(makeActionConfig('getConsensusState', 'key'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "consensus_state" with key_name/value, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getConsensusState(makeActionConfig('getConsensusState', 'key'));
        expect(query).to.include('`XChain_Hub`.consensus_state m');
        expect(query).to.include('m.key_name');
        expect(query).to.include('m.value');
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getConfigs', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getConfigs(makeActionConfig('getConfigs', 'coin'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "configs" with coin/network/module/param, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getConfigs(makeActionConfig('getConfigs', 'module'));
        expect(query).to.include('`XChain_Hub`.configs m');
        expect(query).to.include('m.coin');
        expect(query).to.include('m.network');
        expect(query).to.include('m.module');
        expect(query).to.include('m.param_name');
        expect(query).to.include('m.param_value');
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getTelemetryPings', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getTelemetryPings(makeActionConfig('getTelemetryPings', 'event'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "telemetry_pings" with the software fingerprint, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getTelemetryPings(makeActionConfig('getTelemetryPings', 'event'));
        expect(query).to.include('`XChain_Hub`.telemetry_pings m');
        expect(query).to.include('m.install_id');
        expect(query).to.include('m.node_version');
        expect(query).to.include('m.os_platform');
        expect(query).to.include('m.event');
        expect(query).to.include('ORDER BY m.id');
    });

    it('never selects the ip_hash column (privacy: the keyed IP hash stays hub-internal)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getTelemetryPings(makeActionConfig('getTelemetryPings'));
        expect(query).to.not.include('ip_hash');
    });
});

describe('Database.getCheckpointAtOrAbove ordering (SPV latest-default)', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        sinon.stub(db, '_checkpointSource').returns({ table: 'state_checkpoints', filter: '', filterParams: [] });
    });
    afterEach(() => sinon.restore());

    it('orders DESC (latest checkpoint) when height is null', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (config, q) => { captured = q; return []; });
        await db.getCheckpointAtOrAbove(cfg(), null);
        expect(captured).to.match(/ORDER BY sc\.block_index DESC LIMIT 1/);
        expect(captured).to.not.match(/block_index >= \?/);
    });

    it('orders ASC (nearest at or above) when a height is given', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (config, q) => { captured = q; return []; });
        await db.getCheckpointAtOrAbove(cfg(), 500);
        expect(captured).to.match(/ORDER BY sc\.block_index ASC LIMIT 1/);
        expect(captured).to.match(/block_index >= \?/);
    });
});

// The checkpoint routes are the ONLY REST surface that shapes BigInt indices by
// hand (the catch-all path goes through utility.jsonStringify, which stringifies
// BigInt; so does ws/serialize.js). They emitted JSON numbers, so the same field
// name was a string on /block and a number on /checkpoints, breaking strict
// equality against a WS NEW_BLOCK index. Pin the string wire type here so the
// hand-shaped path cannot drift back.
describe('Database._normalizeCheckpointRows emits BigInt indices as strings @regression', () => {
    const db = makeDb();

    it('coerces block_index/checkpoint_seq/snapshot_block to decimal strings', () => {
        const [row] = db._normalizeCheckpointRows([{
            chain: 'BTC', network: 'mainnet', block_hash: 'ff'.repeat(32),
            block_index: 100n, checkpoint_seq: 7n, snapshot_block: 2000000n
        }]);
        expect(row.block_index).to.equal('100');
        expect(row.checkpoint_seq).to.equal('7');
        expect(row.snapshot_block).to.equal('2000000');
    });

    it('preserves precision past 2^53 (the reason Number() was wrong)', () => {
        const [row] = db._normalizeCheckpointRows([{ block_index: 9007199254740993n, checkpoint_seq: 1n, snapshot_block: 1n }]);
        expect(row.block_index).to.equal('9007199254740993');
    });

    it('leaves non-index fields untouched (validator_signatures excepted: parsed to array)', () => {
        const [row] = db._normalizeCheckpointRows([{
            block_index: 1n, checkpoint_seq: 1n, snapshot_block: 1n,
            state_root: 'ab'.repeat(32), validator_signatures: '[]'
        }]);
        expect(row.state_root).to.equal('ab'.repeat(32));
        expect(row.validator_signatures).to.deep.equal([]);
    });

    it('validator_signatures: one wire type (array) across the checkpoint REST family', () => {
        const sigs = [{ pubkey: 'aa', sig: 'bb' }];
        const mk = (v) => db._normalizeCheckpointRows([{
            block_index: 1n, checkpoint_seq: 1n, snapshot_block: 1n, validator_signatures: v
        }])[0].validator_signatures;
        expect(mk(JSON.stringify(sigs))).to.deep.equal(sigs);   // DB JSON string -> array
        expect(mk(sigs)).to.deep.equal(sigs);                   // already-parsed passthrough
        expect(mk('not json')).to.deep.equal([]);               // malformed degrades to []
        expect(mk(null)).to.deep.equal([]);                     // absent degrades to []
    });

    it('empty/null rows → empty array', () => {
        expect(db._normalizeCheckpointRows(null)).to.deep.equal([]);
        expect(db._normalizeCheckpointRows([])).to.deep.equal([]);
    });
});
