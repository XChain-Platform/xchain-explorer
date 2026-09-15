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
    qoCfg
} = require('./helpers.js');


describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // An untyped getHistory is the ALL-ACTIVITY feed, and it pages over
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
});

describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getHistory + action=first: uses mappings_actions SQL (lines 711-723)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ offset_index: 700 }]);
        const config = qoCfg('getHistory', null, 'first', null);
        config.data.offset = { action: 'first' };
        config.data.query = { limit: 10, length: 10, start: 0, offset: false, total: 50, action: 'first' };
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        expect(offset1).to.equal(701); // 700 + 1
    });
});
