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

const { expect, makeConfig, cfgOffset } = require('../../db_query_builder.test.js');

const { makeQueryBuilderDb } = require('./helpers.js');

let db;

function registerOffsetSqlCases1() {

    it('returns empty string and empty args when offset is absent', async () => {
        const config = makeConfig({ data: { method: 'getActions', type: null } });
        const [sql, args] = await db.getQueryOffsetSql(config);
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when action is null', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', null, 100, 200));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when start is null', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', null, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when start is non-numeric', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 'abc', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('action=next with start only: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, null));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args).to.deep.equal([500]);
    });

    it('action=next with start+stop: two parameterized placeholders', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 100));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    it('action=prev with start only: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'prev', 100, null));
        expect(sql).to.equal(' AND m.action_index > ?');
        expect(args).to.deep.equal([100]);
    });

    it('action=prev with start+stop: two parameterized placeholders', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'prev', 100, 500));
        expect(sql).to.equal(' AND m.action_index > ? AND m.action_index < ?');
        expect(args).to.deep.equal([100, 500]);
    });

    it('action=last with start: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'last', 300, null));
        expect(sql).to.equal(' AND m.action_index <= ?');
        expect(args).to.deep.equal([300]);
    });

}

function registerOffsetSqlCases2() {

    it('action=last with start+stop: parameterized (stop ignored)', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'last', 300, 100));
        expect(sql).to.equal(' AND m.action_index <= ?');
        expect(args).to.deep.equal([300]);
    });

    it('unknown action with start+stop: falls through to next-style clause', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'first', 500, 100));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    it('getBlocks action=next with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'next', 800, 600));
        expect(sql).to.equal(' AND b1.block_index < ?');
        expect(args).to.deep.equal([800]);
    });

    it('getBlocks action=prev with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'prev', 200, null));
        expect(sql).to.equal(' AND b1.block_index > ?');
        expect(args).to.deep.equal([200]);
    });

    it('getBlocks action=last with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'last', 500, null));
        expect(sql).to.equal(' AND b1.block_index <= ?');
        expect(args).to.deep.equal([500]);
    });

    it('getBlocks: stop is always suppressed even when provided', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'prev', 200, 100));
        expect(sql).to.equal(' AND b1.block_index > ?');
        expect(args).to.deep.equal([200]);
    });

    it('getTokens action=next with start+stop: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'next', 50, 10));
        expect(sql).to.equal(' AND m.id < ? AND m.id > ?');
        expect(args).to.deep.equal([50, 10]);
    });

    it('getTokens action=prev with start: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'prev', 10, null));
        expect(sql).to.equal(' AND m.id > ?');
        expect(args).to.deep.equal([10]);
    });

    it('getTokens action=last with start: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'last', 75, null));
        expect(sql).to.equal(' AND m.id <= ?');
        expect(args).to.deep.equal([75]);
    });

}

function registerOffsetSqlCases3() {

    it('start/stop are parsed as integers (string numbers accepted)', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '500', '100'));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    // Defensive guards: an empty or missing start or action must produce no
    // offset clause at all, never a half-built one.
    it('returns empty when offset exists but start is empty string', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty when offset exists but start is undefined', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', undefined, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty when action is empty string', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', '', 100, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('action=next with start and stop=0: stop is false after sanitizeInt', async () => {
        // stop=0 comes back 0 from sanitizeInt, and 0 is falsy, so `if(stop)` treats it as absent.
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 0));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args).to.deep.equal([500]);
    });

    it('sanitizeInt default false: non-numeric start falls back to false', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 'abc', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

}

describe('Database#getQueryOffsetSql', () => {
    before(() => { db = makeQueryBuilderDb(); });
    registerOffsetSqlCases1();
    registerOffsetSqlCases2();
    registerOffsetSqlCases3();
});
