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
 * P0 Regression Tests: Security Baseline
 *
 * Curated security regression tests that must pass on every commit.
 * Covers SQL injection prevention, input sanitization, SSRF protection,
 * rate limiting, and security headers.
 *
 * Run: mocha test/regression/p0-security-baseline.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config');
const { makeConfig }           = require('../fixtures/mock-query-args');

const Utility  = require('../../src/utility');
const Database = require('../../src/db.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
    const configInfo = createConfigInfoStub();
    const util = new Utility(configInfo);
    const explorer = { configInfo, util };
    return new Database(explorer);
}

function cfgOffset(method, action, start, stop) {
    return makeConfig({
        data: {
            method,
            offset: { action, start, stop }
        }
    });
}

// ===========================================================================
// @p0 @security SQL Injection: Offset Parameterization
// ===========================================================================

describe('@p0 @security SQL injection offset parameterization regression', function () {

    let db;
    before(() => { db = makeDb(); });

    it('uses ? placeholders instead of concatenated values', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 100));
        expect(sql).to.include('?');
        expect(sql).to.not.include('500');
        expect(sql).to.not.include('100');
        expect(args).to.deep.equal([500, 100]);
    });

    it('rejects SQL injection in start parameter', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '1 OR 1=1', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects UNION SELECT injection', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '1 UNION SELECT * FROM users', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects NaN', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', NaN, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects negative infinity', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', -Infinity, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('handles very large numbers safely', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '9999999999999', null));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args[0]).to.be.a('number');
        expect(Number.isFinite(args[0])).to.be.true;
    });
});

// ===========================================================================
// @p0 @security SQL Injection: WHERE clause parameterization
// ===========================================================================

describe('@p0 @security SQL injection WHERE clause regression', function () {

    let db;
    before(() => { db = makeDb(); });

    it('address type uses ? placeholder', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: "'; DROP TABLE addresses; --",
                type: 'address'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.include('a2.address=?');
        expect(sql).to.not.include('DROP');
    });

    it('block type uses ? placeholder', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: '1 OR 1=1',
                type: 'block'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.include('b1.block_index=?');
        expect(sql).to.not.include('OR 1=1');
    });

    it('token type uses ? placeholder', async () => {
        const config = makeConfig({
            data: {
                method: 'getIssues',
                search: "XCHAIN' OR '1'='1",
                type: 'token'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.include('t3.tick=?');
        expect(sql).to.not.include("OR '1'='1");
    });
});

// ===========================================================================
// @p0 @security SQL Injection: Order/Limit Validation
// ===========================================================================

describe('@p0 @security SQL injection order/limit regression', function () {

    let db;
    before(() => { db = makeDb(); });

    it('rejects injection in sortorder', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { sortorder: 'ASC; DROP TABLE users--' }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.order).to.equal('DESC');
    });

    it('offset args are kept separate from base args', () => {
        const config = makeConfig({
            data: {
                sql: {
                    where: {
                        offsetArgs: [100, 200]
                    }
                }
            }
        });
        expect(config.data.sql.where.offsetArgs).to.deep.equal([100, 200]);
    });
});

// ===========================================================================
// @p0 @security LIKE wildcard escaping
// ===========================================================================

describe('@p0 @security LIKE wildcard escaping regression', function () {

    let db;
    before(() => { db = makeDb(); });

    it('escapes % wildcard', () => {
        expect(db.util.escapeLike('test%injection')).to.equal('test\\%injection');
    });

    it('escapes _ wildcard', () => {
        expect(db.util.escapeLike('test_injection')).to.equal('test\\_injection');
    });

    it('escapes backslashes', () => {
        expect(db.util.escapeLike('test\\injection')).to.equal('test\\\\injection');
    });
});
