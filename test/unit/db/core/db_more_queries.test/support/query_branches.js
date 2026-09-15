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

describe('Database#getActionSummaryData: non-SEND actions', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // Same reason as the sibling describe above: getActionData is stubbed here, so
        // the shared-leg prefetch has no reader (see action-preload-parity.test.js).
        sinon.stub(db, 'buildActionPreload').resolves(null);
    });
    afterEach(() => { sinon.restore(); });

    it('copies direct fields from info to details for non-SEND action (line 6070)', async () => {
        sinon.stub(db, 'getActionData').resolves({
            action: 'ISSUE',
            status: 'valid',
            tick: 'XCHAIN',
            source: 'addr1',
            amount: '100',
            // No sends array, so the fields are copied across as they are.
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

let db;

// Later edits change an order's expiration, and each match deducts from what the
// order still has left to give and to get.
describe('Database#getOrderInfoBatch: edit + match loops', () => {
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
});

describe('Database#getOrderInfoBatch: edit + match loops', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
