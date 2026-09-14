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

// Batch tests for many action types.
describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
        // A cache hit means the second read made no new database query.
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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});
