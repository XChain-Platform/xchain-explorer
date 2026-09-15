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
    // JOINs the permissions manifest (protocol/controller-bound-tokens.md).
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
