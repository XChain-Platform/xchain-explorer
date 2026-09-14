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
    stubForType,
    queryHasTable
} = require('./helpers.js');

let db;

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
