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

    // The raw action feed is the only surface that claims to enumerate the chain
    // action by action, and a system-injected action (DISPENSE, *_MATCH,
    // *_EXPIRE, DISPENSER_CLOSE, CROSS_SETTLE, a mirror-applied ATTEST v1
    // response) has a real block_index but NO transactions row at all. Reaching
    // `blocks` through an INNER-joined `transactions` deleted every one of them
    // from the feed, invisibly: well-formed JSON, consistent paging, rows simply
    // absent. The behavioural proof against real rows lives in
    // test/conformance/actions-feed-txless.test.js; these two pin the join shape
    // so it cannot drift back in the fast tier.
    it('reaches blocks through the ACTION own block_index, never through a transaction', async () => {
        const db = makeDb();
        const [query, , count] = await db.getActions(makeActionConfig('getActions'));
        for(const sql of [query, count]){
            expect(sql).to.include('INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)');
            expect(sql, 'blocks is joined through the transaction again, which drops every tx-less action')
                .to.not.include('b1.block_index=t1.block_index');
        }
    });
});

describe('Database#getActions', () => {
    it('LEFT joins transactions in both the row query and the count query', async () => {
        const db = makeDb();
        const [query, , count] = await db.getActions(makeActionConfig('getActions'));
        for(const sql of [query, count]){
            expect(sql).to.include('LEFT  JOIN transactions       t1 ON (t1.tx_index=m.tx_index)');
            expect(sql, 'an INNER join on transactions deletes system-injected actions from the feed')
                .to.not.include('INNER JOIN transactions');
        }
        // tx_index comes off the action own column, so it survives a missing
        // transactions row rather than depending on a join that cannot resolve.
        expect(query).to.include('m.tx_index');
    });
});

describe('Database#getAction', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('calls getActionData with config.data.search once the index resolves to a type', async () => {
        // getAction now asks getActionType first and answers [null] for an
        // index with no actions row (test/unit/action-not-found.test.js),
        // so the detail path is only reached when a type comes back.
        sinon.stub(db, 'getActionType').resolves('SEND');
        const stub = sinon.stub(db, 'getActionData').resolves({ action: 'SEND' });
        const config = cfg({ data: { search: '100' } });
        const [data] = await db.getAction(config);
        expect(stub.calledOnceWith(config, '100')).to.be.true;
        expect(data).to.deep.equal({ action: 'SEND' });
    });
});
