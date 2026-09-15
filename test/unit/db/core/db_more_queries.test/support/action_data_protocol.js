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

let db;

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
        // chunk fields are routed ONLY through the deploy_chunks query (via `extra`) and
        // the base row carries action_format:4 but no chunk fields, so the assertions
        // only pass if the action_format probe actually drove the v4 branch.
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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});

describe('Database#getActionData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
});
