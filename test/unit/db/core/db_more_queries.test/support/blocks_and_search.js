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

    // Five categories since the contract identity manifest: a search UI reads the
    // whole totals map to decide which tabs to offer, so a missing key is a tab that
    // never appears rather than one that reads zero.
    it('data has totals for addresses, broadcasts, contracts, tokens, transactions', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 0 }]);
        const config = makeActionConfig('getSearch', 'address');
        config.data.search = 'addr';
        const [data] = await db.getSearch(config);
        expect(data.totals).to.have.keys(['addresses', 'broadcasts', 'contracts', 'tokens', 'transactions']);
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
});

describe('Database#getSearch', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // Search terms under 3 characters are refused before any query runs, because a
    // term that short forces a scan that matches a large share of every table.
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
        expect(data.totals).to.have.keys(['addresses', 'broadcasts', 'contracts', 'tokens', 'transactions']);
    });

    // Search results stop at 100 rows whatever limit the pager asks for, so a
    // popular term cannot turn into a runaway scan.
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

let db;

describe('Database#getHistoryData', () => {
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
});

describe('Database#getHistoryData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
