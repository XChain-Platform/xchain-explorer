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
 *
 * The indexed address and block lanes run against tables built from the
 * indexer's REAL DDL, translated to SQLite the way db_live_feed_real_ddl.test.js
 * does it, through the same getQuery and runListQuery path a request takes. A
 * column the joined tables lack throws here, and every row set is compared
 * with the one the a2.address / b1.block_index form selects on the same data.
 *
 ********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { runListQuery }         = require('../../../../src/db/query_sql/data_rows.js');
const { ACTION_SOURCE_SQL }    = require('../../../../src/db/query_sql/where_source_lanes.js');
const { runOnSqlite }          = require('../../../helpers/indexer_ddl_sqlite.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DDL_FILES = ['blocks', 'transactions', 'actions', 'index_actions', 'index_addresses',
    'index_transactions', 'index_statuses', 'index_memos', 'index_tickers', 'index_coins',
    'issues', 'coinpays', 'coinpay_expires', 'links'];

// Mechanical MariaDB -> SQLite translation, type and engine syntax only.
function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/ UNSIGNED/g, '')
        .replace(/CHARACTER SET \w+ COLLATE \w+/g, '')
        .replace(/^\s*(UNIQUE\s+)?KEY\s+\w+\s*\([^)]*\),?[^\n]*$/gm, '')
        .replace(/,([ \t]*--[^\n]*)?\s*\n\) ENGINE/g, '$1\n) ENGINE')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        .replace(/^CREATE\s+(UNIQUE\s+)?INDEX[^;]*;/gim, '');
}

let sqlite, db;

function loadRealSchema() {
    for (const t of DDL_FILES)
        if (!fs.existsSync(path.join(INDEXER_SQL_DIR, t + '.sql'))) this.skip();
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e) { this.skip(); }
    sqlite = new DatabaseSync(':memory:');
    for (const t of DDL_FILES)
        sqlite.exec(toSqlite(fs.readFileSync(path.join(INDEXER_SQL_DIR, t + '.sql'), 'utf8')));
}

function run(sql, ...args) {
    return sqlite.prepare(sql).run(...args);
}

// tx null is a chain-generated action with no transactions row.
function addAction(actionIndex, block, tx, txSourceId, sourceId) {
    if (tx !== null) {
        run('INSERT INTO index_transactions (id, hash) VALUES (?, ?)', tx, 'hash-' + tx);
        run('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (?, ?, ?, ?)',
            tx, block, tx, txSourceId);
    }
    run('INSERT INTO actions (action_index, block_index, tx_index, action_id, source_id) VALUES (?, ?, ?, 1, ?)',
        actionIndex, block, tx, sourceId);
}

// Addresses A=1, B=2, C=3 (C has no actions). Action 1 names its own source A
// over a transaction sent by B; action 2 names none and falls back to its
// transaction's A; action 3 names B over a transaction sent by A; action 4 is
// chain-generated with no source at all.
function seed() {
    for (const [id, address] of [[1, 'A'], [2, 'B'], [3, 'C']])
        run('INSERT INTO index_addresses (id, address) VALUES (?, ?)', id, address);
    run('INSERT INTO index_actions (id, action) VALUES (1, \'ISSUE\')');
    run('INSERT INTO blocks (block_index, block_time) VALUES (100, 1000), (101, 1010)');
    addAction(1, 100, 10, 2, 1);
    addAction(2, 100, 11, 1, null);
    addAction(3, 101, 12, 1, 2);
    addAction(4, 101, null, null, null);
    addAction(5, 101, 13, 1, 1);
    addAction(6, 101, null, null, null);
    for (const ai of [1, 2, 3, 4]) {
        run('INSERT INTO issues (action_index) VALUES (?)', ai);
        run('INSERT INTO links (action_index) VALUES (?)', ai);
    }
    run('INSERT INTO coinpays (action_index, obligation_action_index, coin_amount, txid, vout, block_index) VALUES (5, 9, \'1\', \'t\', 0, 101)');
    run('INSERT INTO coinpay_expires (action_index, obligation_action_index) VALUES (6, 9)');
}

function resetFixture() {
    const configInfo = createConfigInfoStub();
    db = new Database({ configInfo, util: new Utility(configInfo) });
    for (const t of DDL_FILES) sqlite.exec('DELETE FROM ' + t + ';');
    seed();
    sinon.stub(db, 'doQuery').callsFake(async (config, query, args) =>
        runOnSqlite(sqlite, query, args));
}

// One list request through the path getData takes: getQuery, then runListQuery.
async function list(method, type, search) {
    const config = makeConfig({ data: { method, type, search } });
    const [query, args, count] = await db.getQuery(config);
    const [rows, total] = await runListQuery(db, config, query, args, count);
    return { rows, total, where: config.data.sql.where.data };
}

// The same request with the data-WHERE put back to the join-column form.
async function listJoinForm(method, type, search, from, to) {
    const config = makeConfig({ data: { method, type, search } });
    const [query, , count] = await db.getQuery(config);
    const rows  = sqlite.prepare(query.replace(from, to)).all(search);
    const total = sqlite.prepare(count.replace(from, to)).all(search)[0].total;
    return { rows, total: Number(total) };
}

const indexes = (rows) => rows.map((r) => Number(r.action_index));

describe('indexed source lane against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('selects the action source first and the transaction source only as a fallback', async () => {
        const a = await list('getIssues', 'address', 'A');
        expect(a.where).to.include(ACTION_SOURCE_SQL);
        expect(indexes(a.rows)).to.deep.equal([2, 1]);
        expect(a.total).to.equal(2);
        expect(a.rows.map((r) => r.source)).to.deep.equal(['A', 'A']);
        expect(indexes((await list('getIssues', 'address', 'B')).rows)).to.deep.equal([3]);
    });

    it('returns the same rows and total as the a2.address form for every address', async () => {
        for (const method of ['getIssues', 'getLinks']) {
            for (const address of ['A', 'B', 'C', 'nobody']) {
                const fast = await list(method, 'address', address);
                const join = await listJoinForm(method, 'address', address, ACTION_SOURCE_SQL, ' AND a2.address=?');
                expect(fast.rows, `${method} ${address}`).to.deep.equal(join.rows);
                expect(fast.total, `${method} ${address}`).to.equal(join.total);
            }
        }
    });

    it('answers an unknown address with an empty page and a zero total', async () => {
        const result = await list('getIssues', 'address', 'nobody');
        expect(result.rows).to.deep.equal([]);
        expect(result.total).to.equal(0);
    });

    it('lists coinpays and coinpay expires by address on columns their joins carry', async () => {
        expect(indexes((await list('getCoinpays', 'address', 'A')).rows)).to.deep.equal([5]);
        expect(indexes((await list('getCoinpays', 'address', 'B')).rows)).to.deep.equal([]);
        const expires = await list('getCoinpayExpires', 'address', 'A');
        expect(expires.rows).to.deep.equal([]);
        expect(expires.total).to.equal(0);
    });

    it('the a2.address form these two replaced names a column their joins do not carry', async () => {
        for (const method of ['getCoinpays', 'getCoinpayExpires']) {
            const attempt = listJoinForm(method, 'address', 'A', ACTION_SOURCE_SQL, ' AND a2.address=?');
            let message = '';
            await attempt.catch((e) => { message = e.message; });
            expect(message, method).to.match(/no such column: a2\.address/);
        }
    });
});

describe('explorer paging boundaries against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    // The first-page boundary is one past the newest matching action_index.
    async function firstBoundary(type, search) {
        const config = makeConfig({ type: 'explorer', data: { method: 'getIssues', type, search,
            offset: { action: 'first', start: null, stop: null } } });
        const [offset1] = await db.getQueryOffsets(config, false, 10);
        return offset1;
    }

    it('opens the address and block feeds at the rows the list selects', async () => {
        expect(await firstBoundary('address', 'A')).to.equal(3);
        expect(await firstBoundary('address', 'B')).to.equal(4);
        expect(await firstBoundary('block', '100')).to.equal(3);
        expect(await firstBoundary('block', '101')).to.equal(5);
    });
});

describe('indexed block lane against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('returns the same rows and total as the b1.block_index form', async () => {
        for (const method of ['getIssues', 'getLinks', 'getCoinpays', 'getCoinpayExpires']) {
            for (const block of ['100', '101', '102']) {
                const fast = await list(method, 'block', block);
                expect(fast.where, method).to.include(' AND a1.block_index=?');
                const join = await listJoinForm(method, 'block', block, ' AND a1.block_index=?', ' AND b1.block_index=?');
                expect(fast.rows, `${method} ${block}`).to.deep.equal(join.rows);
                expect(fast.total, `${method} ${block}`).to.equal(join.total);
            }
        }
        expect(indexes((await list('getIssues', 'block', '101')).rows)).to.deep.equal([4, 3]);
        expect(indexes((await list('getCoinpayExpires', 'block', '101')).rows)).to.deep.equal([6]);
    });
});
