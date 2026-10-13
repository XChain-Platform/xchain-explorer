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
 * An in-memory SQLite database built from the indexer's REAL table DDL.
 *
 * The translation touches type, engine and index syntax only, and every
 * table's column list is asserted unchanged, so a reader query that names a
 * column the schema lacks throws here as it would in MariaDB. Index statements
 * are dropped: SQLite index names are schema-global, and no reader result may
 * depend on an index anyway. MariaDB-only optimizer hints are stripped from a
 * query before SQLite prepares it.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { siblingCheckout, skipOrFail } = require('./sibling_checkout.js');

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/ UNSIGNED/g, '')
        .replace(/CHARACTER SET \w+ COLLATE \w+/g, '')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        .replace(/^CREATE\s+(UNIQUE\s+)?INDEX[^;]*;/gim, '');
}

function columnsOf(ddl, table) {
    const m = ddl.match(new RegExp('CREATE TABLE ' + table + ' \\(([\\s\\S]*?)\\)\\s*(ENGINE|;)'));
    if (!m) throw new Error('CREATE TABLE ' + table + ' not found');
    return m[1].split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s/.test(l)).map(l => l.split(/\s+/)[0]);
}

/**
 * Open the tables inside a mocha hook, or skip/fail the suite through
 * skipOrFail when the sibling indexer cannot be trusted or node:sqlite is absent.
 *
 * @param {object} ctx     the mocha `this`
 * @param {string[]} tables indexer table names, one DDL file each
 * @returns {object|null} a node:sqlite DatabaseSync, or null after a skip
 */
function openIndexerTables(ctx, tables) {
    for (const t of tables) {
        const verdict = siblingCheckout(__dirname, path.join(INDEXER_SQL_DIR, t + '.sql'));
        if (!verdict.usable) {
            skipOrFail(ctx, verdict, 'the real indexer DDL ' + t + ' table');
            return null;
        }
    }
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e) { ctx.skip(); return null; }
    const sqlite = new DatabaseSync(':memory:');
    for (const t of tables) {
        const raw  = fs.readFileSync(path.join(INDEXER_SQL_DIR, t + '.sql'), 'utf8');
        const lite = toSqlite(raw);
        const same = JSON.stringify(columnsOf(lite, t)) === JSON.stringify(columnsOf(raw, t));
        if (!same) throw new Error('translated ' + t + ' DDL changed its column list');
        sqlite.exec(lite);
    }
    return sqlite;
}

/** Run one reader statement the way doQuery would, minus MariaDB-only hints. */
function runOnSqlite(sqlite, query, args) {
    const lite = String(query).replace(/\bSELECT\s+(DISTINCT\s+)?STRAIGHT_JOIN\b/g, 'SELECT $1');
    return sqlite.prepare(lite).all(...(args || []));
}

module.exports = { openIndexerTables, runOnSqlite, toSqlite };
