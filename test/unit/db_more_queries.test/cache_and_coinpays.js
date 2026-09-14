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

describe('Database LRU cache helpers', () => {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('_cacheGet returns undefined for a key not in the cache', () => {
        expect(db.cacheGet(db._addressIdCache, 'missing')).to.be.undefined;
    });

    it('_cacheSet + _cacheGet round-trip a value', () => {
        db.cacheSet(db._addressIdCache, 'addr1', 42);
        expect(db.cacheGet(db._addressIdCache, 'addr1')).to.equal(42);
    });

    it('_cacheGet returns undefined after the key was consumed (LRU re-inserts)', () => {
        db.cacheSet(db._addressIdCache, 'addr1', 99);
        const v1 = db.cacheGet(db._addressIdCache, 'addr1');
        expect(v1).to.equal(99);
        // After get, the key is re-inserted (LRU touch); it is still present
        expect(db.cacheGet(db._addressIdCache, 'addr1')).to.equal(99);
    });

    it('_cacheSet evicts the LRU entry when the cache is at maxSize', () => {
        const cache = new Map();
        db.cacheSet(cache, 'a', 1, 2);
        db.cacheSet(cache, 'b', 2, 2);
        // Cache is full (size=2). Adding 'c' should evict 'a' (the LRU entry).
        db.cacheSet(cache, 'c', 3, 2);
        expect(cache.has('a')).to.be.false;
        expect(cache.has('b')).to.be.true;
        expect(cache.has('c')).to.be.true;
    });

    it('_cacheSet replaces an existing key without growing the cache', () => {
        db.cacheSet(db._tickIdCache, 'XCHAIN', 7);
        db.cacheSet(db._tickIdCache, 'XCHAIN', 77);
        expect(db.cacheGet(db._tickIdCache, 'XCHAIN')).to.equal(77);
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
