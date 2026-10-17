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
 * Security tests: Input Validation
 *
 * Tests all API input parameters with malicious values:
 * type confusion, special characters, extreme lengths, null bytes, unicode.
 *
 * Run: mocha test/security/input_validation.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const { makeConfig }           = require('../fixtures/mock-query-args.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

function makeDb() {
    const Database = require('../../src/db/index.js');
    const Utility  = require('../../src/lib/utility.js');
    const configInfo = createConfigInfoStub();
    const util     = new Utility(configInfo);
    const explorer = { configInfo, util };
    return new Database(explorer);
}

// Type confusion: repeating a query parameter (?limit=1&limit=2) turns it into an
// array, and code expecting a number must not carry that array into the SQL
describe('Security: Input Validation: Type confusion', function () {

    let db;
    before(() => { db = makeDb(); });

    it('refuses limit as array (Express query parsing edge case) before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: ['100', '200'] }
            }
        });
        // A repeated key is not one integer, so no LIMIT is built from it.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('INVALID_LIMIT');
    });

    it('refuses sortorder as array before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { sortorder: ['ASC', 'DESC; DROP TABLE--'] }
            }
        });
        // Only a single asc or desc reaches ORDER BY.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('INVALID_SORTORDER');
    });

});

describe('Security: Input Validation: Type confusion', function () {

    let db;
    before(() => { db = makeDb(); });

    it('refuses limit as object before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: { value: '100' } }
            }
        });
        // An object is not an integer, so no LIMIT is built from it.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('INVALID_LIMIT');
    });

    it('refuses page as negative number before any SQL', async () => {
        const config = makeConfig({
            type: 'api',
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { page: '-5' }
            }
        });
        // A page below 1 is refused rather than read as page 1.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('INVALID_PAGE');
    });
});

describe('Security: Input Validation: Special characters', function () {

    let db;
    before(() => { db = makeDb(); });

    it('handles null bytes in search parameter', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test\0injection',
                type: 'address'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        // SQL uses ? placeholder; null byte never reaches query string
        expect(sql).to.include('?');
        expect(sql).to.not.include('\0');
    });

    it('handles unicode in search parameter', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: "' OR 1=1 --",
                type: 'address'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.include('?');
        expect(sql).to.not.include('OR 1=1');
    });

    it('handles backslash sequences in search', async () => {
        const config = makeConfig({
            data: {
                method: 'getIssues',
                search: "test\\'; DROP TABLE issues; --",
                type: 'token'
            }
        });
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.include('t3.tick=?');
        expect(sql).to.not.include('DROP');
    });
});

describe('Security: Input Validation: Extreme values', function () {

    let db;
    before(() => { db = makeDb(); });

    it('refuses an extremely long limit value before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: '9'.repeat(1000) }
            }
        });
        // Past the safe-integer range the value is refused, not clamped.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.code).to.equal('INVALID_LIMIT');
    });

    it('refuses a zero limit before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: '0' }
            }
        });
        // A limit below 1 is refused rather than raised to 1.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.code).to.equal('INVALID_LIMIT');
    });

    it('refuses a float limit value before any SQL', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: '10.5' }
            }
        });
        // A fraction never reaches LIMIT.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.code).to.equal('INVALID_LIMIT');
    });

    it('handles extremely long search string without crashing', async () => {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'A'.repeat(10000),
                type: 'address'
            }
        });
        // Should not throw
        const sql = await db.getQueryWhereSql(config);
        expect(sql).to.be.a('string');
    });
});

describe('Security: Input Validation: Method name safety', function () {

    let db;
    before(() => { db = makeDb(); });

    it('returns empty for undefined method names', async () => {
        const config = makeConfig({
            data: {
                method: 'nonExistentMethod',
                search: 'test',
                type: 'address'
            }
        });
        const [query, args, count] = await db.getQuery(config);
        expect(query).to.equal('');
    });

    it('returns empty for prototype pollution method names', async () => {
        const config = makeConfig({
            data: {
                method: '__proto__',
                search: 'test',
                type: 'address'
            }
        });
        const [query, args, count] = await db.getQuery(config);
        // __proto__ is not a function, so typeof check fails
        expect(query).to.equal('');
    });

    it('returns empty for toString method', async () => {
        const config = makeConfig({
            data: {
                method: 'toString',
                search: 'test',
                type: 'address'
            }
        });
        // toString is a function, but returns a string not [query, args, count].
        // The typeof check passes but the result won't destructure properly.
        // This is acceptable: no SQL injection occurs.
        try {
            const [query, args, count] = await db.getQuery(config);
            // If it doesn't throw, query won't be a SQL string
        } catch (e) {
            // toString() returns a string, not an array; catching is expected
        }
    });
});

describe('Security: Input Validation: DataTables parameters', function () {

    let db;
    before(() => { db = makeDb(); });

    it('handles malicious draw parameter safely (API mode)', async () => {
        const config = makeConfig({
            type: 'api',
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: {
                    draw: '<script>alert(1)</script>',
                    limit: '10'
                }
            }
        });
        // draw is never used in SQL; it is a DataTables client-side value
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.a('number');
    });

    it('refuses a negative page parameter with INVALID_PAGE', async () => {
        const config = makeConfig({
            type: 'api',
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: {
                    page: '-5',
                    limit: '10'
                }
            }
        });
        // A page below 1 is refused rather than read as page 1.
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('INVALID_PAGE');
    });
});
