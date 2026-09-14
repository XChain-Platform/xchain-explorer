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
 * Unit tests for SQL generation functions in src/db/index.js
 *
 * Tests:
 *   - getMaxMethodResults(method)
 *   - getQueryWhereSql(config)
 *   - getQueryOffsetSql(config)
 */

'use strict';

const { expect }    = require('chai');
const proxyquire    = require('proxyquire');
const Utility       = require('../../src/lib/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

// Create a Database instance without a real MariaDB connection.
const Database = proxyquire('../../src/db/index.js', {
    './connection.js': proxyquire('../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new Database(mockExplorer);
}

// Helper: build a minimal config for getQueryWhereSql / getQueryOffsetSql
function cfg(method, type, extras = {}) {
    return makeConfig({ data: { method, type, ...extras } });
}

// Helper: build a minimal config with offset data
function cfgOffset(method, action, start, stop) {
    return makeConfig({
        data: {
            method,
            type: null,
            offset: { action, start, stop }
        }
    });
}

describe('Database#getMaxMethodResults', () => {
    let db;
    before(() => { db = makeDb(); });

    it('returns 500 for getBalances', () => {
        expect(db.getMaxMethodResults('getBalances')).to.equal(500);
    });

    it('returns 500 for getHolders', () => {
        expect(db.getMaxMethodResults('getHolders')).to.equal(500);
    });

    it('returns 100 for getActions (default)', () => {
        expect(db.getMaxMethodResults('getActions')).to.equal(100);
    });

    it('returns 100 for getTokens (default)', () => {
        expect(db.getMaxMethodResults('getTokens')).to.equal(100);
    });

    it('returns 100 for getSends (default)', () => {
        expect(db.getMaxMethodResults('getSends')).to.equal(100);
    });

    it('returns 100 for an unknown method string', () => {
        expect(db.getMaxMethodResults('nonExistentMethod')).to.equal(100);
    });

    it('returns 100 when method is undefined', () => {
        expect(db.getMaxMethodResults(undefined)).to.equal(100);
    });

    it('returns 100 when method is null', () => {
        expect(db.getMaxMethodResults(null)).to.equal(100);
    });

    it('returns 100 for getBlocks', () => {
        expect(db.getMaxMethodResults('getBlocks')).to.equal(100);
    });

    it('returns 100 for getMarket', () => {
        expect(db.getMaxMethodResults('getMarket')).to.equal(100);
    });
});

module.exports = { expect, makeConfig, makeDb, cfg, cfgOffset };

require('./db_query_builder.test/where_sql.js');
require('./db_query_builder.test/offset_sql.js');
require('./db_query_builder.test/cross_chain.js');
require('./db_query_builder.test/get_query.js');
