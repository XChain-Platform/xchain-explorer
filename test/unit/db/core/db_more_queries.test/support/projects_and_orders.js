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

    // The pair is stored in whichever orientation traded first, so the query matches
    // both and resolves the caller's tick1 to the side it actually is: two label binds,
    // four CASE binds that ask "is tick1 side one?", then the two-orientation WHERE.
    it('binds the caller ticks for the labels, the CASEs and both orientations', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getMarketInfo(cfg(), 'XCHAIN', 'BTC');
        expect(capturedArgs).to.deep.equal([
            'XCHAIN', 'BTC',                             // the tick1 / tick2 labels echoed back
            'XCHAIN', 'XCHAIN', 'XCHAIN', 'XCHAIN',      // last_price / volume_24h / bid / ask side pick
            'XCHAIN', 'BTC', 'BTC', 'XCHAIN'             // stored either way round
        ]);
    });

    it('never selects a column markets does not have', async () => {
        let query = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { query = q; return []; });
        await db.getMarketInfo(cfg(), 'XCHAIN', 'BTC');
        // markets holds its stats per side (tick1_*/tick2_*); these four names were
        // selected as if they were columns, so every subscribe raised 'Unknown column'
        // and the channel pushed an empty snapshot.
        for (const phantom of ['m.last_price', 'm.volume_24h', 'm.bid', 'm.ask'])
            expect(query, phantom).to.not.include(phantom);
        expect(query).to.include('as last_price');
        expect(query).to.include('as volume_24h');
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
