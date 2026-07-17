/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Regression test for  (deep-review 2026-07-17 F1): the reorg
 * tip-poll in db.checkReorgAndInvalidate selected a `block_hash` column
 * that does not exist in the indexer's blocks table (the schema stores
 * only *_hash_id references into index_transactions). Every unit test
 * stubbed doQuery, so the bad SQL was never executed against the real
 * schema and the throw silently killed the live WS feed on every poll.
 *
 * This suite executes the ACTUAL SQL issued by checkReorgAndInvalidate
 * against tables built from the indexer's REAL DDL files
 * (xchain-indexer/src/sql/blocks.sql + index_transactions.sql), loaded
 * verbatim and mechanically translated to SQLite (type/engine syntax
 * only; column names are asserted untouched). A query referencing a
 * non-existent column throws here, exactly as MariaDB does in prod.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

// Real indexer DDL, from the sibling repo in the platform monorepo checkout.
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DDL_FILES = ['blocks.sql', 'index_transactions.sql'];

// Mechanical MariaDB -> SQLite translation. Touches ONLY type/engine syntax;
// extractColumns() below asserts the column identifiers survive unchanged.
function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/BIGINT UNSIGNED/g, 'BIGINT')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        // SQLite has no prefix indexes: `hash(64)` -> `hash`
        .replace(/\((\w+)\(\d+\)\)/g, '($1)');
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

describe(' checkReorgAndInvalidate against the REAL indexer DDL', function () {

    let sqlite, db, cfg;

    before(function () {
        // Skip only when this checkout is the standalone explorer repo without
        // the sibling indexer (the platform monorepo + bin/ci-all.sh have it).
        for (const f of DDL_FILES) {
            if (!fs.existsSync(path.join(INDEXER_SQL_DIR, f))) this.skip();
        }
        let DatabaseSync;
        try { ({ DatabaseSync } = require('node:sqlite')); }
        catch (e) { this.skip(); }   // node:sqlite ships with the required Node 22
        sqlite = new DatabaseSync(':memory:');

        for (const f of DDL_FILES) {
            const raw   = fs.readFileSync(path.join(INDEXER_SQL_DIR, f), 'utf8');
            const table = f.replace('.sql', '');
            const lite  = toSqlite(raw);
            // The translation must not add/drop/rename columns, or this suite
            // would be testing a schema that drifted from the real one.
            expect(extractColumns(lite, table)).to.deep.equal(extractColumns(raw, table));
            sqlite.exec(lite);
        }
    });

    beforeEach(function () {
        const configInfo = createConfigInfoStub();
        const util       = new Utility(configInfo);
        db  = new Database({ configInfo, util });
        cfg = makeConfig({ coin: 'BTC' });
        sqlite.exec('DELETE FROM blocks; DELETE FROM index_transactions;');
        // Route the queries under test through the real-DDL SQLite tables so
        // any reference to a non-existent column throws like MariaDB's
        // ER_BAD_FIELD_ERROR (this is the assertion that caught F1).
        sinon.stub(db, 'doQuery').callsFake(async (config, query, args) =>
            sqlite.prepare(query).all(...(args || [])));
    });

    afterEach(() => sinon.restore());

    function addHash(hash) {
        return Number(sqlite.prepare('INSERT INTO index_transactions (hash) VALUES (?)').run(hash).lastInsertRowid);
    }
    function addBlock(index, ledgerHash) {
        const hashId = (ledgerHash === null) ? null : addHash(ledgerHash);
        sqlite.prepare('INSERT INTO blocks (block_index, block_time, ledger_hash_id) VALUES (?, ?, ?)')
            .run(index, 1700000000 + index, hashId);
    }
    function dropBlocksFrom(index) {
        sqlite.prepare('DELETE FROM blocks WHERE block_index >= ?').run(index);
    }

    it('runs the tip poll against the real schema without a bad-column error', async function () {
        addBlock(100, 'ledger-100');
        const reorg = await db.checkReorgAndInvalidate(cfg);
        expect(reorg).to.equal(false);
        expect(db._lastTip.BTC).to.deep.equal({ index: 100, hash: 'ledger-100' });
    });

    it('does not invalidate on a clean append', async function () {
        addBlock(100, 'ledger-100');
        await db.checkReorgAndInvalidate(cfg);
        addBlock(101, 'ledger-101');
        expect(await db.checkReorgAndInvalidate(cfg)).to.equal(false);
        expect(db._reorgGen.BTC || 0).to.equal(0);
    });

    it('invalidates when the block at a seen height is replaced (hash changed)', async function () {
        addBlock(100, 'ledger-100');
        await db.checkReorgAndInvalidate(cfg);
        dropBlocksFrom(100);
        addBlock(100, 'ledger-100-b');
        addBlock(101, 'ledger-101-b');
        expect(await db.checkReorgAndInvalidate(cfg)).to.equal(true);
        expect(db._reorgGen.BTC).to.equal(1);
    });

    it('invalidates when the tip rewinds', async function () {
        addBlock(99, 'ledger-99');
        addBlock(100, 'ledger-100');
        await db.checkReorgAndInvalidate(cfg);
        dropBlocksFrom(100);
        expect(await db.checkReorgAndInvalidate(cfg)).to.equal(true);
    });

    it('stays quiet across polls when ledger hashing is off (NULL ledger_hash_id)', async function () {
        addBlock(100, null);
        await db.checkReorgAndInvalidate(cfg);
        addBlock(101, null);
        expect(await db.checkReorgAndInvalidate(cfg)).to.equal(false);
        expect(await db.checkReorgAndInvalidate(cfg)).to.equal(false);
        expect(db._reorgGen.BTC || 0).to.equal(0);
    });
});
