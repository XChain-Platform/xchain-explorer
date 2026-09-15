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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../../fixtures/mock-query-args.js');
const mockResults              = require('../../../../../fixtures/mock-db-results.js');

// The MariaDB driver is stubbed: these tests never open a real pool.
const Database = proxyquire('../../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

// Shared minimal config used across tests
function cfg(overrides = {}) {
    return makeConfig({ coin: 'BTC', ...overrides });
}

const WHERE_DATA = 'm.action_index IS NOT NULL';

function makeActionConfig(method, type = 'address', extras = {}) {
    return makeConfig({
        data: {
            method,
            search: 'addr1',
            type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: WHERE_DATA, offset: '' }
            },
            ...extras
        }
    });
}

// Helper: build a minimal row for most action types
function baseRow(extra = {}) {
    return {
        action: extra.action || 'SEND',
        action_format: 0,
        action_index: 100,
        source: 'addr1',
        block_index: 500,
        timestamp: 1700000000,
        tx_hash: 'abc123',
        tx_index: 1,
        memo: null,
        status: 'valid',
        ...extra
    };
}

// Helper: check if a query references a given table name (handles newlines)
function queryHasTable(q, table) {
    if(!q) return false;
    return new RegExp(table, 'i').test(q);
}

// Helper: stub common doQuery dispatch and stubs for fee/tx
function stubForType(db, type, mainRow, extra = {}) {
    sinon.stub(db, 'getActionType').resolves(type);
    sinon.stub(db, 'getActionFeeData').resolves(null);
    sinon.stub(db, 'getTransactionData').resolves(null);
    sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
        // credits/debits/escrows always resolve empty
        if(q && (queryHasTable(q,'\\bcredits\\b') || queryHasTable(q,'\\bdebits\\b') || queryHasTable(q,'\\bescrows\\b'))) return [];
        // Extra routing provided by caller
        for(const [pattern, rows] of Object.entries(extra)){
            if(q && q.includes(pattern)) return rows;
        }
        // Any other query gets the main row
        if(mainRow) return [mainRow];
        return [];
    });
}

function qoCfg(method, type, action, search, query) {
    return makeConfig({
        coin: 'BTC',
        data: {
            method,
            type,
            search: search || 'addr1',
            query:  Object.assign({ limit: 10, length: 10, start: 0, offset: false, total: 50, action }, query || {}),
            sql:    { where: { data: '', offset: '', offsetArgs: [] }, order: 'DESC', limit: 10 },
            offset: { action }
        }
    });
}

module.exports = {
    Database,
    configInfo,
    sinon,
    expect,
    makeConfig,
    mockResults,
    makeDb,
    cfg,
    makeActionConfig,
    baseRow,
    queryHasTable,
    stubForType,
    qoCfg
};
