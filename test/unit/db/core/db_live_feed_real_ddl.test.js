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
 * The live WebSocket feed readers (getBlocksSince, getActionsSince) run
 * against tables built from the indexer's REAL DDL, translated to SQLite the
 * way db_reorg_real_ddl.test.js does it. A stubbed doQuery cannot tell a join
 * that drops system-synthesized actions from one that keeps them; this can.
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

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

// Real indexer DDL, from the sibling repo in the platform monorepo checkout.
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DDL_FILES = ['blocks', 'transactions', 'actions', 'index_actions', 'index_addresses', 'index_transactions',
    'sends', 'sweeps', 'dispenses', 'mints', 'messages', 'fees', 'slash_events', 'capability_slash_events',
    'bridge_settlements'];

// Mechanical MariaDB -> SQLite translation, type and engine syntax only. Index
// statements are dropped (SQLite index names are schema-global, MariaDB's are
// per table) and in-table KEY lines with them; columns are asserted unchanged.
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

// Pull the column names out of a CREATE TABLE body (real or translated).
function extractColumns(ddl, table) {
    const m = ddl.match(new RegExp('CREATE TABLE ' + table + ' \\(([\\s\\S]*?)\\)\\s*(ENGINE|;)'));
    if (!m) throw new Error('CREATE TABLE ' + table + ' not found');
    return m[1].split('\n')
        .map(l => l.trim())
        .filter(l => /^[a-z_]+\s/.test(l))
        .map(l => l.split(/\s+/)[0]);
}

let sqlite, db, cfg;

function loadRealSchema() {
    // Skip only when this checkout has no sibling indexer (a standalone explorer clone).
    for (const t of DDL_FILES) {
        if (!fs.existsSync(path.join(INDEXER_SQL_DIR, t + '.sql'))) this.skip();
    }
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e) { this.skip(); }
    sqlite = new DatabaseSync(':memory:');
    for (const t of DDL_FILES) {
        const raw  = fs.readFileSync(path.join(INDEXER_SQL_DIR, t + '.sql'), 'utf8');
        const lite = toSqlite(raw);
        expect(extractColumns(lite, t), t).to.deep.equal(extractColumns(raw, t));
        sqlite.exec(lite);
    }
}

function resetFixture() {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    db  = new Database({ configInfo, util });
    cfg = makeConfig({ coin: 'BTC' });
    for (const t of DDL_FILES) sqlite.exec('DELETE FROM ' + t + ';');
    // Route every query through the real-DDL tables, so a bad column throws.
    sinon.stub(db, 'doQuery').callsFake(async (config, query, args) =>
        sqlite.prepare(query).all(...(args || [])));
}

function addAddress(address) {
    return Number(sqlite.prepare('INSERT INTO index_addresses (address) VALUES (?)').run(address).lastInsertRowid);
}

function addActionName(action) {
    return Number(sqlite.prepare('INSERT INTO index_actions (action) VALUES (?)').run(action).lastInsertRowid);
}

function addTx(txIndex, blockIndex) {
    const hashId = Number(sqlite.prepare('INSERT INTO index_transactions (hash) VALUES (?)').run('tx-' + txIndex).lastInsertRowid);
    sqlite.prepare('INSERT INTO transactions (tx_index, block_index, tx_hash_id) VALUES (?, ?, ?)').run(txIndex, blockIndex, hashId);
}

// txIndex null is a system-synthesized action: a real block_index, no transactions row.
function addAction(actionIndex, blockIndex, txIndex, name, sourceId) {
    sqlite.prepare('INSERT INTO actions (action_index, block_index, tx_index, action_id, source_id) VALUES (?, ?, ?, ?, ?)')
        .run(actionIndex, blockIndex, txIndex, addActionName(name), sourceId === undefined ? null : sourceId);
}

describe('live feed readers against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('getBlocksSince counts a system-synthesized action (NULL tx_index) in action_count', async function () {
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)').run(100, 1700000100);
        addTx(1, 100);
        addAction(10, 100, 1, 'SEND');
        addAction(11, 100, null, 'XBRIDGE');

        const rows = await db.getBlocksSince(cfg, 99, 10);

        expect(rows).to.have.lengthOf(1);
        expect(Number(rows[0].tx_count)).to.equal(1);
        expect(Number(rows[0].action_count)).to.equal(2);
    });

    it('getBlocksSince action_count matches the number of rows getActionsSince returns for the block', async function () {
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)').run(200, 1700000200);
        addTx(5, 200);
        addAction(20, 200, 5, 'SEND');
        addAction(21, 200, null, 'BET_EXPIRE');
        addAction(22, 200, null, 'XPOLICY');

        const [block] = await db.getBlocksSince(cfg, 199, 10);
        const actions = await db.getActionsSince(cfg, 19, 100);

        expect(Number(block.action_count)).to.equal(actions.filter(a => Number(a.block_index) === 200).length);
    });

    it('getActionsSince gives an XBRIDGE settle leg its credited address and a policy row none', async function () {
        addAction(30, 300, null, 'XBRIDGE');
        addAction(31, 300, null, 'XPOLICY');
        sqlite.prepare(`INSERT INTO bridge_settlements (action_index, transfer_id, kind, block_index, dest_address)
                        VALUES (?, ?, 'transfer', ?, ?)`).run(30, 'a'.repeat(64), 300, 'bc1qdest');
        sqlite.prepare(`INSERT INTO bridge_settlements (action_index, transfer_id, kind, block_index, dest_address)
                        VALUES (?, ?, 'policy', ?, NULL)`).run(31, 'b'.repeat(64), 300);

        const rows = await db.getActionsSince(cfg, 29, 100);
        const byIndex = new Map(rows.map(r => [Number(r.action_index), r]));

        expect(byIndex.get(30).source).to.equal(null);
        expect(byIndex.get(30).destinations).to.deep.equal(['bc1qdest']);
        expect(byIndex.get(31).destinations).to.deep.equal([]);
    });

});

// Second block keeps each describe callback under the function-length limit.
describe('live feed readers against the REAL indexer DDL (sends union)', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('getActionsSince still resolves a sends destination through the same union', async function () {
        const src  = addAddress('1src');
        const dest = addAddress('1dest');
        addTx(7, 400);
        addAction(40, 400, 7, 'SEND', src);
        sqlite.prepare('INSERT INTO sends (action_index, destination_id) VALUES (?, ?)').run(40, dest);

        const rows = await db.getActionsSince(cfg, 39, 100);

        expect(rows[0].source).to.equal('1src');
        expect(rows[0].destinations).to.deep.equal(['1dest']);
        // One feed read plus ONE union: the whole union, bridge branch included, is valid SQL.
        expect(db.doQuery.callCount).to.equal(2);
    });
});
