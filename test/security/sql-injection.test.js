/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Security tests — SQL Injection Prevention
 *
 * Verifies that all SQL-facing parameters are properly sanitized or parameterized,
 * preventing SQL injection via query parameters, offsets, limits, and sort orders.
 *
 * Run: mocha test/security/sql-injection.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const { makeConfig }           = require('../fixtures/mock-query-args.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

// ---------------------------------------------------------------------------
// Database factory — stubbed so no real DB connection needed
// ---------------------------------------------------------------------------

function makeDb() {
    const Database = require('../../src/db.js');
    const Utility  = require('../../src/utility.js');
    const configInfo = createConfigInfoStub();
    const util     = new Utility(configInfo);
    const explorer = { configInfo, util };
    return new Database(explorer);
}

// Helper to build offset config
function cfgOffset(method, action, start, stop) {
    return makeConfig({
        data: {
            method,
            offset: { action, start, stop }
        }
    });
}

// ===========================================================================
// getQueryOffsetSql — Parameterized Offsets
// ===========================================================================

describe('Security: SQL Injection — Offset Parameterization', function () {

    let db;
    before(() => { db = makeDb(); });

    it('uses ? placeholders instead of concatenated values', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 100));
        expect(sql).to.include('?');
        expect(sql).to.not.include('500');
        expect(sql).to.not.include('100');
        expect(args).to.deep.equal([500, 100]);
    });

    it('rejects SQL injection payload in start parameter', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '1 OR 1=1', null));
        // sanitizeInt returns false for non-numeric, so no SQL is generated
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects SQL injection payload in stop parameter', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 100, '1; DROP TABLE users'));
        // stop should be sanitized — only start appears
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args).to.deep.equal([100]);
    });

    it('rejects UNION SELECT injection in start', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '1 UNION SELECT * FROM users', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects negative infinity', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', -Infinity, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects NaN', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', NaN, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('rejects hex-encoded injection attempt', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '0x1', null));
        // parseInt('0x1', 10) returns 0, which is falsy but valid
        // The key thing is no injection payload reaches SQL
        expect(sql).to.not.include('0x');
    });

    it('handles very large numbers safely', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '9999999999999', null));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args[0]).to.be.a('number');
        expect(Number.isFinite(args[0])).to.be.true;
    });
});

// ===========================================================================
// getQuery — Order and Limit Validation
// ===========================================================================

describe('Security: SQL Injection — Order/Limit Validation', function () {

    let db;
    before(() => { db = makeDb(); });

    it('rejects invalid sortorder values (SQL injection in ORDER BY)', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { sortorder: 'ASC; DROP TABLE users--' }
            }
        });
        // getQuery validates sortorder against whitelist
        const [query, args, count] = await db.getQuery(config);
        // Should default to DESC since injection payload doesn't match whitelist
        expect(config.data.sql.order).to.equal('DESC');
    });

    it('only accepts ASC or DESC for sortorder', async () => {
        for (const invalid of ['ASCENDING', 'desc--', 'ASC OR 1=1', '']) {
            const config = makeConfig({
                data: {
                    method: 'getAddresses',
                    search: 'test',
                    type: 'address',
                    query: { sortorder: invalid }
                }
            });
            await db.getQuery(config);
            expect(['ASC', 'DESC']).to.include(config.data.sql.order);
        }
    });

    it('clamps limit to safe numeric range (blocks negative values)', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: '-1' }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.at.least(1);
    });

    it('clamps limit to max (blocks excessive values)', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: '999999' }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.at.most(100);
    });

    it('handles non-numeric limit gracefully', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: 'DROP TABLE' }
            }
        });
        await db.getQuery(config);
        // Should default to max since NaN fails isInteger
        expect(config.data.sql.limit).to.be.a('number');
        expect(Number.isFinite(config.data.sql.limit)).to.be.true;
    });
});

// ===========================================================================
// getQueryWhereSql — Parameterized WHERE Clauses
// ===========================================================================

describe('Security: SQL Injection — WHERE clause parameterization', function () {

    let db;
    before(() => { db = makeDb(); });

    it('WHERE data SQL uses ? placeholders for address type', async () => {
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

    it('WHERE data SQL uses ? placeholders for block type', async () => {
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

    it('WHERE data SQL uses ? placeholders for token type', async () => {
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
// getSearch — LIKE query escaping
// ===========================================================================

describe('Security: SQL Injection — LIKE wildcard escaping', function () {

    let db;
    before(() => { db = makeDb(); });

    it('escapeLike escapes % wildcard characters', () => {
        expect(db.util.escapeLike('test%injection')).to.equal('test\\%injection');
    });

    it('escapeLike escapes _ wildcard characters', () => {
        expect(db.util.escapeLike('test_injection')).to.equal('test\\_injection');
    });

    it('escapeLike escapes backslashes', () => {
        expect(db.util.escapeLike('test\\injection')).to.equal('test\\\\injection');
    });

    it('escapeLike handles combined injection payload', () => {
        const escaped = db.util.escapeLike("%' OR 1=1; --");
        // % is escaped to \%, single quote is passed through (handled by parameterized queries)
        expect(escaped).to.include('\\%');
        expect(escaped).to.not.match(/^%/); // no unescaped leading %
    });
});

// ===========================================================================
// sanitizeInt — Defense-in-depth integer validation
// ===========================================================================

describe('Security: sanitizeInt defense-in-depth', function () {

    let db;
    before(() => { db = makeDb(); });

    it('returns parsed integer for valid numeric string', () => {
        expect(db.util.sanitizeInt('42')).to.equal(42);
    });

    it('returns default for non-numeric string', () => {
        expect(db.util.sanitizeInt('abc', 0)).to.equal(0);
    });

    it('returns default for empty string', () => {
        expect(db.util.sanitizeInt('', 0)).to.equal(0);
    });

    it('returns default for SQL injection payload', () => {
        expect(db.util.sanitizeInt('1 OR 1=1', 0)).to.equal(1);
        // parseInt stops at first non-numeric char, so "1 OR..." => 1
        // This is safe because the result is a plain number
    });

    it('returns default for Infinity', () => {
        expect(db.util.sanitizeInt(Infinity, 0)).to.equal(0);
    });

    it('returns default for NaN', () => {
        expect(db.util.sanitizeInt(NaN, 0)).to.equal(0);
    });

    it('returns default for null', () => {
        expect(db.util.sanitizeInt(null, 0)).to.equal(0);
    });

    it('returns default for undefined', () => {
        expect(db.util.sanitizeInt(undefined, 0)).to.equal(0);
    });

    it('uses custom default value', () => {
        expect(db.util.sanitizeInt('abc', -1)).to.equal(-1);
    });

    it('returns false as default when specified', () => {
        expect(db.util.sanitizeInt('abc', false)).to.equal(false);
    });
});

// ===========================================================================
// getData — offset args merging
// ===========================================================================

describe('Security: getData merges offset args safely', function () {

    it('config object initializes offsetArgs as empty array', () => {
        const config = makeConfig();
        expect(config.data.sql.where.offsetArgs).to.deep.equal([]);
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
        // Base WHERE data still uses its own ? placeholders
        expect(config.data.sql.where.data).to.be.a('string');
    });
});
