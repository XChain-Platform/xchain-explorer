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
 * The two-party address lane runs against tables built from the indexer's
 * REAL DDL, translated to SQLite as source_lanes_real_ddl.test.js does, through
 * the getQuery and runListQuery path a request takes. Every page, total and
 * explorer boundary is compared with the one the (a2.address=? OR
 * a3.address=?) form selects on the same data, including an action whose
 * source comes only from its transaction, an address on both sides of one
 * action, and a multi-send whose legs pay different addresses.
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
const { pruneCountJoins }      = require('../../../../src/db/query_sql/count_joins.js');
const { TWO_PARTY_ADDRESS_METHODS, TWO_PARTY_ADDRESS_SQL } = require('../../../../src/db/query_sql/where_source_lanes.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const FAMILIES  = ['messages', 'mints', 'orders', 'sends', 'sweeps', 'dispensers'];
const DDL_FILES = ['blocks', 'transactions', 'actions', 'index_actions', 'index_addresses',
    'index_transactions', 'index_statuses', 'index_memos', 'index_tickers', 'index_coins', 'index_fiats',
    'order_statuses', 'order_matches', 'dispenses'].concat(FAMILIES);
const METHODS   = ['getMessages', 'getMints', 'getOrders', 'getSends', 'getSweeps', 'getDispensers', 'getDispenses'];
const ADDRESSES = ['A', 'B', 'C', 'D', 'nobody'];
const OLD_SQL   = ' AND (a2.address=? OR a3.address=?)';

// Mechanical MariaDB -> SQLite translation, type and engine syntax only.
function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/ UNSIGNED/g, '')
        .replace(/ENUM\([^)]*\)/g, 'TEXT')
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
function addAction(actionIndex, tx, txSourceId, sourceId) {
    if (tx !== null) {
        run('INSERT INTO index_transactions (id, hash) VALUES (?, ?)', tx, 'hash-' + tx);
        run('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (?, 100, ?, ?)',
            tx, tx, txSourceId);
    }
    run('INSERT INTO actions (action_index, block_index, tx_index, action_id, source_id) VALUES (?, 100, ?, 1, ?)',
        actionIndex, tx, sourceId);
}

// Addresses A=1, B=2, C=3, D=4 (D takes part in nothing). Each row is
// [action, tx, tx source, action source, counterparty]: 1 names its own
// source A over a transaction sent by B; 2 names none and falls back to its
// transaction's A; 3 is B's and pays A, over a transaction A sent; 4 is A's
// and pays A; 5 is chain-generated and pays C; 6 is C's and pays no one.
const ACTION_ROWS = [[1, 11, 2, 1, 3], [2, 12, 1, null, 2], [3, 13, 1, 2, 1],
    [4, 14, 1, 1, 1], [5, null, null, null, 3], [6, 16, 3, 3, null]];

function seedFamilies() {
    for (const [ai, tx, txSource, source] of ACTION_ROWS) addAction(ai, tx, txSource, source);
    for (const [ai, , , , party] of ACTION_ROWS) {
        for (const table of ['messages', 'mints', 'sweeps'])
            run(`INSERT INTO ${table} (action_index, destination_id) VALUES (?, ?)`, ai, party);
        run('INSERT INTO sends (action_index, leg_ordinal, destination_id) VALUES (?, 0, ?)', ai, party);
        for (const table of ['orders', 'dispensers'])
            run(`INSERT INTO ${table} (action_index, get_address_id) VALUES (?, ?)`, ai, party);
    }
    // A multi-send from B paying A on one leg and C on the other.
    addAction(7, 17, 2, 2);
    run('INSERT INTO sends (action_index, leg_ordinal, destination_id) VALUES (7, 0, 1), (7, 1, 3)');
}

// Fills as [action, dispenser, destination]. A dispenser's address is its
// get_address_id: 3 and 4 are A's, 2 is B's, 6 has none. A takes part in 20
// through the dispenser, in 21 as the buyer, and in 22 as both.
function seedDispenses() {
    for (const [ai, dispenser, destination] of [[20, 3, 2], [21, 6, 1], [22, 4, 1], [23, 6, 3], [24, 2, 4]]) {
        addAction(ai, ai + 10, destination, null);
        run('INSERT INTO dispenses (action_index, dispenser_action_index, destination_id) VALUES (?, ?, ?)',
            ai, dispenser, destination);
    }
}

function resetFixture() {
    const configInfo = createConfigInfoStub();
    db = new Database({ configInfo, util: new Utility(configInfo) });
    for (const t of DDL_FILES) sqlite.exec('DELETE FROM ' + t + ';');
    for (const [id, address] of [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']])
        run('INSERT INTO index_addresses (id, address) VALUES (?, ?)', id, address);
    run('INSERT INTO index_actions (id, action) VALUES (1, \'SEND\')');
    run('INSERT INTO blocks (block_index, block_time) VALUES (100, 1000)');
    seedFamilies();
    seedDispenses();
    sinon.stub(db, 'doQuery').callsFake(async (config, query, args) =>
        sqlite.prepare(query).all(...(args || [])));
}

// One list request through the path getData takes: getQuery, then runListQuery.
async function list(method, search) {
    const config = makeConfig({ data: { method, type: 'address', search } });
    const [query, args, count] = await db.getQuery(config);
    const [rows, total] = await runListQuery(db, config, query, args, count);
    return { rows, total, where: config.data.sql.where.data, count };
}

// The same request with the data-WHERE put back to the two-join OR form.
async function listOldForm(method, search) {
    const config = makeConfig({ data: { method, type: 'address', search } });
    const [query, , count] = await db.getQuery(config);
    const lane  = TWO_PARTY_ADDRESS_SQL[method];
    const rows  = sqlite.prepare(query.replace(lane, OLD_SQL)).all(search, search);
    const total = sqlite.prepare(count.replace(lane, OLD_SQL)).all(search, search)[0].total;
    return { rows, total: Number(total) };
}

async function firstBoundary(method, search) {
    const config = makeConfig({ type: 'explorer', data: { method, type: 'address', search,
        offset: { action: 'first', start: null, stop: null } } });
    const [offset1] = await db.getQueryOffsets(config, false, 10);
    return offset1;
}

const indexes = (rows) => rows.map((r) => Number(r.action_index));

describe('two-party address lane against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('covers exactly the methods the lane names', () => {
        expect([...TWO_PARTY_ADDRESS_METHODS].sort()).to.deep.equal([...METHODS].sort());
    });

    it('returns the same rows and total as the two-join OR form for every address', async () => {
        for (const method of METHODS) {
            for (const address of ADDRESSES) {
                const fast = await list(method, address);
                expect(fast.where, method).to.include(TWO_PARTY_ADDRESS_SQL[method]);
                const old = await listOldForm(method, address);
                expect(fast.rows, `${method} ${address}`).to.deep.equal(old.rows);
                expect(fast.total, `${method} ${address}`).to.equal(old.total);
            }
        }
    });

    it('lists the transaction-only source, the counterparty, and a both-sides action once', async () => {
        for (const method of ['getMessages', 'getMints', 'getOrders', 'getSweeps', 'getDispensers']) {
            const a = await list(method, 'A');
            expect(indexes(a.rows), method).to.deep.equal([4, 3, 2, 1]);
            expect(a.total, method).to.equal(4);
            expect(indexes((await list(method, 'C')).rows), method).to.deep.equal([6, 5, 1]);
        }
        const fills = await list('getDispenses', 'A');
        expect(indexes(fills.rows)).to.deep.equal([22, 21, 20]);
        expect(fills.total).to.equal(3);
    });

    it('keeps only the legs a multi-send pays to an address that is not its source', async () => {
        const legs = (rows) => rows.filter((r) => Number(r.action_index) === 7).map((r) => r.destination);
        expect(legs((await list('getSends', 'A')).rows)).to.deep.equal(['A']);
        expect(legs((await list('getSends', 'C')).rows)).to.deep.equal(['C']);
        expect(legs((await list('getSends', 'B')).rows)).to.deep.equal(['A', 'C']);
        expect((await list('getSends', 'A')).total).to.equal(5);
    });

    it('answers an unknown address with an empty page and a zero total', async () => {
        for (const method of METHODS) {
            const result = await list(method, 'nobody');
            expect(result.rows, method).to.deep.equal([]);
            expect(result.total, method).to.equal(0);
        }
    });

    it('counts over the joins the lane reads once display joins are pruned', async () => {
        for (const method of METHODS) {
            const pruned = pruneCountJoins((await list(method, 'A')).count);
            expect(pruned, method).to.not.match(/index_memos|index_statuses|index_tickers/);
            const binds = new Array((pruned.match(/\?/g) || []).length).fill(1);
            const total = sqlite.prepare(pruned).all(...binds)[0].total;
            expect(Number(total), method).to.equal((await listOldForm(method, 'A')).total);
        }
    });

    it('opens the explorer feed one past the newest action the list selects', async () => {
        for (const method of METHODS) {
            for (const address of ['A', 'B', 'C']) {
                const newest = Math.max(...indexes((await listOldForm(method, address)).rows));
                expect(await firstBoundary(method, address), `${method} ${address}`).to.equal(newest + 1);
            }
        }
    });
});
