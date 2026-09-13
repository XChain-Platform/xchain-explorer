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
 * P0 Regression Tests: Core Unit
 *
 * Curated unit tests for the most critical utility functions,
 * input sanitization, and formatting logic. These run on every
 * commit and must always pass.
 *
 * No database or network required; pure unit tests.
 *
 * Run: mocha test/regression/p0-core-unit.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const Utility = require('../../src/utility');
const { createConfigInfoStub } = require('../fixtures/mock-config');
const { makeConfig }           = require('../fixtures/mock-query-args');

function makeUtil() {
    return new Utility(createConfigInfoStub());
}

function makeDb() {
    const Database = require('../../src/db.js');
    const configInfo = createConfigInfoStub();
    const util = new Utility(configInfo);
    const explorer = { configInfo, util };
    return new Database(explorer);
}

describe('@p0 @core sanitizeInt regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('parses valid positive integer string', function () {
        expect(u.sanitizeInt('42')).to.equal(42);
    });

    it('parses zero string', function () {
        expect(u.sanitizeInt('0')).to.equal(0);
    });

    it('returns default for non-numeric string', function () {
        expect(u.sanitizeInt('abc', 0)).to.equal(0);
    });

    it('returns default for empty string', function () {
        expect(u.sanitizeInt('', 0)).to.equal(0);
    });

    it('returns default for null', function () {
        expect(u.sanitizeInt(null, 0)).to.equal(0);
    });

    it('returns default for undefined', function () {
        expect(u.sanitizeInt(undefined, 0)).to.equal(0);
    });

    it('returns default for NaN', function () {
        expect(u.sanitizeInt(NaN, 0)).to.equal(0);
    });

    it('returns default for Infinity', function () {
        expect(u.sanitizeInt(Infinity, 0)).to.equal(0);
    });

    it('returns false as default when specified', function () {
        expect(u.sanitizeInt('abc', false)).to.equal(false);
    });

    it('truncates injection payload to leading number', function () {
        // parseInt('1 OR 1=1') => 1, which is a safe number
        expect(u.sanitizeInt('1 OR 1=1', 0)).to.equal(1);
    });
});

describe('@p0 @core escapeLike regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('escapes % wildcard', function () {
        expect(u.escapeLike('test%value')).to.equal('test\\%value');
    });

    it('escapes _ wildcard', function () {
        expect(u.escapeLike('test_value')).to.equal('test\\_value');
    });

    it('escapes backslash', function () {
        expect(u.escapeLike('test\\value')).to.equal('test\\\\value');
    });

    it('handles combined injection payload', function () {
        const escaped = u.escapeLike("%' OR 1=1; --");
        expect(escaped).to.include('\\%');
        expect(escaped).to.not.match(/^%/);
    });

    it('returns unchanged string when no special chars', function () {
        expect(u.escapeLike('normalstring')).to.equal('normalstring');
    });
});

describe('@p0 @core isNull regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('returns true for null', function ()      { expect(u.isNull(null)).to.be.true; });
    it('returns true for undefined', function () { expect(u.isNull(undefined)).to.be.true; });
    it('returns true for empty string', function () { expect(u.isNull('')).to.be.true; });
    it('returns false for 0', function ()        { expect(u.isNull(0)).to.be.false; });
    it('returns false for false', function ()    { expect(u.isNull(false)).to.be.false; });
    it('returns false for non-empty string', function () { expect(u.isNull('x')).to.be.false; });
    it('returns false for object', function ()   { expect(u.isNull({})).to.be.false; });
});

describe('@p0 @core isNumeric regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('true for integer', function ()       { expect(u.isNumeric(42)).to.be.true; });
    it('true for float', function ()         { expect(u.isNumeric(3.14)).to.be.true; });
    it('true for numeric string', function (){ expect(u.isNumeric('100')).to.be.true; });
    it('true for zero', function ()          { expect(u.isNumeric(0)).to.be.true; });
    it('true for negative', function ()      { expect(u.isNumeric(-5)).to.be.true; });
    it('false for NaN', function ()          { expect(u.isNumeric(NaN)).to.be.false; });
    it('false for Infinity', function ()     { expect(u.isNumeric(Infinity)).to.be.false; });
    it('false for empty string', function () { expect(u.isNumeric('')).to.be.false; });
    it('false for alpha string', function () { expect(u.isNumeric('abc')).to.be.false; });
    it('false for null', function ()         { expect(u.isNumeric(null)).to.be.false; });
});

describe('@p0 @core millisecondsToTimeString regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('returns empty string for sub-second values', function () {
        // 42ms = 0s, 0m, 0h, 0d -> empty string (by design)
        expect(u.millisecondsToTimeString(42)).to.equal('');
        expect(u.millisecondsToTimeString(0)).to.equal('');
    });

    it('formats seconds range (1500ms)', function () {
        const result = u.millisecondsToTimeString(1500);
        expect(result).to.be.a('string');
        expect(result).to.include('s');
    });

    it('formats large value with hours and minutes', function () {
        const result = u.millisecondsToTimeString(3661000);
        expect(result).to.be.a('string');
        expect(result).to.include('h');
        expect(result).to.include('m');
    });

    it('getTimerString falls back to ms format for sub-second', function () {
        // getTimerString uses millisecondsToTimeString but falls back to "Xms"
        const result = u.getTimerString(42);
        expect(result).to.equal('42ms');
    });
});

describe('@p0 @core error logging regression', function () {

    let u;
    before(function () { u = makeUtil(); });

    it('throwError throws an Error with the provided message', function () {
        expect(() => u.throwError('test error')).to.throw(Error, 'test error');
    });

    it('logError throws via throwError (debug mode)', function () {
        // logError currently calls throwError, which throws
        expect(() => u.logError('test error', 'context')).to.throw(Error, 'test error');
    });
});

describe('@p0 @core query builder sortorder regression', function () {

    let db;
    before(function () { db = makeDb(); });

    it('only accepts ASC or DESC', async function () {
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

    it('accepts valid ASC', async function () {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { sortorder: 'ASC' }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.order).to.equal('ASC');
    });

    it('defaults to DESC for no sortorder', async function () {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: {}
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.order).to.equal('DESC');
    });
});

describe('@p0 @core query builder limit clamping regression', function () {

    let db;
    before(function () { db = makeDb(); });

    it('clamps negative limit to >= 1', async function () {
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

    it('clamps excessive limit to <= 100', async function () {
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

    it('handles non-numeric limit gracefully', async function () {
        const config = makeConfig({
            data: {
                method: 'getAddresses',
                search: 'test',
                type: 'address',
                query: { limit: 'DROP TABLE' }
            }
        });
        await db.getQuery(config);
        expect(config.data.sql.limit).to.be.a('number');
        expect(Number.isFinite(config.data.sql.limit)).to.be.true;
    });
});
