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

const { expect, cfg } = require('../db_query_builder.test.js');

const { makeQueryBuilderDb } = require('./helpers.js');

let db;

function registerWhereSqlCases1() {

    it('default: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getActions', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('getIssues with no type: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('getBalances: base is m.address_id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBalances', null));
        expect(sql).to.equal('m.address_id IS NOT NULL');
    });

    it('getHolders: base is m.address_id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHolders', null));
        expect(sql).to.equal('m.address_id IS NOT NULL');
    });

    it('getBlocks: base is b1.block_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlocks', null));
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('getBlock: base is b1.block_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlock', null));
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('getTransaction: base is m.tx_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTransaction', null));
        expect(sql).to.equal('m.tx_index IS NOT NULL');
    });

    it('getMarket: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarket', null));
        // getMarket always appends tick clause
        expect(sql).to.include('m.id IS NOT NULL');
    });

    it('getMarkets: base is m.id IS NOT NULL (no type)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarkets', null));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('type=address on a standard method: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a2.address=?');
    });

}

function registerWhereSqlCases2() {

    it('type=address on getMessages: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMessages', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getMints: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMints', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getOrders: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getOrders', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getSends: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getSends', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getSweeps: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getSweeps', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getDispensers: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getDispenses: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=block on a standard method: appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'block'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('type=block on getBlocks: does NOT append block clause (getBlocks excluded)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlocks', 'block'));
        // getBlocks is in the exclusion list; only base sql returned
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('type=source on a standard method: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'source'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a2.address=?');
    });

}

function registerWhereSqlCases3() {

    it('type=destination on a standard method: appends AND a3.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'destination'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a3.address=?');
    });

    it('type=oracle on getDispensers: filters on the dispenser oracle_address_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'oracle'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)');
    });

    // The a5 oracle-address join exists only on the getDispensers row query, so
    // the lane must not leak onto sibling methods whose SQL has no such column.
    it('type=oracle on getDispenses: appends nothing (lane is getDispensers-only)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'oracle'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('type=dispenser on getDispenses: filters on the dispense dispenser_action_index', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'dispenser'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.dispenser_action_index=?');
    });

    // Only the dispenses table carries dispenser_action_index; the lane must not
    // leak onto sibling methods whose SQL has no such column.
    it('type=dispenser on getDispensers: appends nothing (lane is getDispenses-only)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'dispenser'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('type=token on a standard method: appends AND t3.tick=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick=?');
    });

    it('type=token on getFiles: appends AND m.type_id=1 AND t4.tick=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getFiles', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=1 AND t4.tick=?');
    });

    it('type=token on getTokens: appends AND t3.tick LIKE ?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTokens', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick LIKE ?');
    });

    it('type=subtoken on getTokens: appends AND t3.tick LIKE ?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTokens', 'subtoken'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick LIKE ?');
    });

    // getMarket always adds its tick pair clause, whatever the search type.
    it('getMarket: appends tick OR-pair clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarket', null));
        expect(sql).to.equal('m.id IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))');
    });

}

function registerWhereSqlCases4() {

    it('getMarkets + type=token: appends AND (COALESCE(t1.tick, c1.coin)=? OR COALESCE(t2.tick, c2.coin)=?)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarkets', 'token'));
        expect(sql).to.equal('m.id IS NOT NULL AND (COALESCE(t1.tick, c1.coin)=? OR COALESCE(t2.tick, c2.coin)=?)');
    });

    it('getMarketOrders: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrders', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))');
    });

    it('getOrderbook: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getOrderbook', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))');
    });

    it('getMarketHistory: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketHistory', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))');
    });

    it('getMarketOrders + search3: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrders', null, { search3: 'addr1' }));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?)) AND a2.address=?');
    });

    it('getMarketHistory + search3: appends AND (a2.address=? OR a3.address=?)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketHistory', null, { search3: 'addr1' }));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?)) AND (a2.address=? OR a3.address=?)');
    });

    it('getHistory + type=address: appends m.type_id=2 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=2 AND m.id=?');
    });

    it('getHistory + type=token: appends m.type_id=1 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=1 AND m.id=?');
    });

    // The block and untyped feeds anchor on a1, not m: getHistoryData drives them
    // off `actions` directly, because mappings_actions carries no row for an action
    // that moved no ledger entry (see db.history-unmapped-actions.test.js).
    it('getHistory + type=block: anchors on a1 and appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'block'));
        expect(sql).to.equal('a1.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('getHistory + no type: returns base a1.action_index IS NOT NULL only', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', null));
        expect(sql).to.equal('a1.action_index IS NOT NULL');
    });

}

function registerWhereSqlCases5() {

    it('getHistory + type=recent: anchors on a1 (the homepage All Activity feed)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'recent'));
        expect(sql).to.equal('a1.action_index IS NOT NULL');
    });

}

describe('Database#getQueryWhereSql', () => {
    before(() => { db = makeQueryBuilderDb(); });
    registerWhereSqlCases1();
    registerWhereSqlCases2();
    registerWhereSqlCases3();
    registerWhereSqlCases4();
    registerWhereSqlCases5();
});
