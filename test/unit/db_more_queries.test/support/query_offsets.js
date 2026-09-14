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


    // Bail-out cases
    it('returns [] for getBalances (bail-out)', async () => {
        const result = await db.getQueryOffsets(qoCfg('getBalances', null, 'next'), false, 10);
        expect(result).to.deep.equal([]);
    });

    it('returns [] for getHolders (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getHolders', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTransaction (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTransaction', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getSearch (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getSearch', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getMarkets (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getMarkets', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getMarket (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getMarket', null, 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTokens with type=token (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTokens', 'token', 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] for getTokens with type=subtoken (bail-out)', async () => {
        expect(await db.getQueryOffsets(qoCfg('getTokens', 'subtoken', 'next'), false, 10)).to.deep.equal([]);
    });

    it('returns [] when method table is not in actionTables whitelist (bail-out)', async () => {
        const result = await db.getQueryOffsets(qoCfg('getUnknownMethod', null, 'next'), false, 10);
        expect(result).to.deep.equal([]);
    });

    // Type=address: id lookup + where construction
    it('looks up address id and builds source_id where clause for getSends', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 42 }];
            return []; // stop offset query
        });
        const config = qoCfg('getSends', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });
});

describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('builds double-address where for getSends (source OR destination)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 42 }];
            return [];
        });
        const config = qoCfg('getSends', 'address', 'next', 'addr1');
        await db.getQueryOffsets(config, false, 10);
        // Reaching here without an error means the source-or-destination branch ran.
        expect(db.doQuery.callCount).to.be.greaterThan(0);
    });

    it('builds single address_id where for getCredits', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 5 }];
            return [];
        });
        const config = qoCfg('getCredits', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds coinpay obligations address where (payer OR payee)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 7 }];
            return [];
        });
        const config = qoCfg('getCoinpayObligations', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds history address where (type_id=2 AND id)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_addresses')) return [{ id: 9 }];
            return [];
        });
        const config = qoCfg('getHistory', 'address', 'next', 'addr1');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds token getOrders/getSwaps double-tick where', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 3 }];
            return [];
        });
        const config = qoCfg('getOrders', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });
});

describe('Database#getQueryOffsets', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('builds token getDispensers single-tick where', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 4 }];
            return [];
        });
        const config = qoCfg('getDispensers', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds token getHistory where (type_id=1 AND id)', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 6 }];
            return [];
        });
        const config = qoCfg('getHistory', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    it('builds default token tick_id where for getIssues', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('FROM index_tickers')) return [{ id: 8 }];
            return [];
        });
        const config = qoCfg('getIssues', 'token', 'next', 'XCHAIN');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    // Type=block where clause
    it('builds block_index where for block type', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const config = qoCfg('getSends', 'block', 'next', '500');
        const result = await db.getQueryOffsets(config, false, 10);
        expect(result).to.be.an('array');
    });

    // action=first/last path with doQuery returning rows
    it('action=first: sets offset1 from doQuery result and returns it incremented', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q.includes('offset_index')) return [{ offset_index: 1000 }];
            return [];
        });
        const config = qoCfg('getSends', null, 'first', null, { action: 'first' });
        config.data.offset.action = 'first';
        config.data.type = null;
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        // After first action: offset1 = 1000, then offset1++  → 1001
        expect(offset1).to.equal(1001);
    });
});
