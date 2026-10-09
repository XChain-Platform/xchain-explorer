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
 * Runs the SQL getActionLedgerTicks issues against tables built from the
 * indexer's real credits, debits, escrows and index_tickers DDL, translated to
 * SQLite for type and engine syntax only, so a column the schema lacks throws
 * here as it would in MariaDB.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DDL_FILES = ['credits.sql', 'debits.sql', 'escrows.sql', 'index_tickers.sql'];

// Type, engine and index-name syntax only (SQLite index names are per database, not
// per table); the column lists are asserted unchanged below.
function toSqlite(ddl) {
    return ddl
        .replace(/CREATE (UNIQUE )?INDEX (\w+)\s+on\s+(\w+)/gi, (m, unique, name, table) => `CREATE ${unique || ''}INDEX ${table}_${name} ON ${table}`)
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/BIGINT UNSIGNED/g, 'BIGINT')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        .replace(/\((\w+)\(\d+\)\)/g, '($1)');
}

function columnsOf(ddl, table) {
    const m = ddl.match(new RegExp('CREATE TABLE ' + table + ' \\(([\\s\\S]*?)\\)\\s*(ENGINE|;)'));
    if (!m) throw new Error('CREATE TABLE ' + table + ' not found');
    return m[1].split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s/.test(l)).map(l => l.split(/\s+/)[0]);
}

let sqlite, db, cfg;

function loadRealSchema() {
    for (const f of DDL_FILES) {
        const verdict = siblingCheckout(__dirname, path.join(INDEXER_SQL_DIR, f));
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the real indexer DDL ledger-ticks guard');
    }
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e) { this.skip(); }
    sqlite = new DatabaseSync(':memory:');
    for (const f of DDL_FILES) {
        const raw   = fs.readFileSync(path.join(INDEXER_SQL_DIR, f), 'utf8');
        const lite  = toSqlite(raw);
        expect(columnsOf(lite, f.replace('.sql', ''))).to.deep.equal(columnsOf(raw, f.replace('.sql', '')));
        sqlite.exec(lite);
    }
}

function resetFixture() {
    const configInfo = createConfigInfoStub();
    db  = new Database({ configInfo, util: new Utility(configInfo) });
    cfg = makeConfig({ coin: 'BTC' });
    sqlite.exec('DELETE FROM credits; DELETE FROM debits; DELETE FROM escrows; DELETE FROM index_tickers;');
    sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => sqlite.prepare(query).all(...(args || [])));
}

function tick(name) {
    return Number(sqlite.prepare('INSERT INTO index_tickers (tick, block_index) VALUES (?, 1)').run(name).lastInsertRowid);
}

function ledgerRow(table, actionIndex, tickId) {
    sqlite.prepare(`INSERT INTO ${table} (action_index, address_id, tick_id, amount) VALUES (?, 1, ?, '1')`).run(actionIndex, tickId);
}

describe('getActionLedgerTicks against the REAL indexer DDL', function () {
    before(loadRealSchema);
    beforeEach(resetFixture);
    afterEach(() => sinon.restore());

    it('names the ticks each action credited, debited or escrowed', async function () {
        const gold = tick('GOLD');
        const fee  = tick('XCHAIN');
        const lead = tick('LEAD');
        ledgerRow('credits', 7, gold);
        ledgerRow('debits', 7, fee);
        ledgerRow('escrows', 8, lead);
        ledgerRow('credits', 9, gold);

        const map = await db.getActionLedgerTicks(cfg, [7n, 8n]);

        expect([...map.keys()].sort()).to.deep.equal(['7', '8']);
        expect([...map.get('7')].sort()).to.deep.equal(['GOLD', 'XCHAIN']);
        expect([...map.get('8')]).to.deep.equal(['LEAD']);
    });
});
