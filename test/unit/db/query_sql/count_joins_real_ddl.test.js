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
 * A pruned list COUNT must equal the COUNT the reader built, on real tables.
 *
 * Every table a list COUNT names is created from the indexer's own DDL file
 * (xchain-indexer/src/sql), translated to SQLite for type and engine syntax
 * only, and filled with seeded rows chosen to break a wrong prune: NULL and
 * dangling id references, tx-less actions, actions whose block is missing,
 * repeated block heights and multi-leg rows. Each list lane then runs both the
 * reader's COUNT and its pruned form and the two answers must match.
 *
 * The suite also reads the uniqueness the pruner relies on out of the same DDL,
 * so a schema change that drops one of those keys fails here first.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const { listQueryArgs } = require('../../../../src/db/query_sql/data_rows.js');
const { parseCountSql, pruneCountJoins, UNIQUE_JOIN_KEYS } = require('../../../../src/db/query_sql/count_joins.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const METHODS = ['getIssues', 'getActions', 'getSends', 'getDestroys', 'getTokens', 'getCollectibles',
                 'getMints', 'getDispensers', 'getDividends', 'getOrders'];
const LANES = [[null, null], ['address', 'X1'], ['block', '100'], ['token', 'X2'],
               ['source', 'X1'], ['destination', 'X2'], ['subtoken', 'X1']];
const ROWS_PER_TABLE = 40;

// Type and engine syntax only; column names and key declarations survive.
function toSqlite(ddl, table){
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/\bUNSIGNED\b/g, '')
        .replace(/CHARACTER SET \w+/g, '')
        .replace(/COLLATE \w+/g, '')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        .replace(/\((\w+)\(\d+\)\)/g, '($1)')
        .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+/gi, (m, u, name) => 'CREATE ' + (u || '') + 'INDEX ' + table + '__' + name + ' ON ');
}

function columnsOf(ddl, table){
    const body = ddl.match(new RegExp('CREATE TABLE ' + table + ' \\(([\\s\\S]*?)\\)\\s*;'));
    return body[1].split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s/.test(l))
        .map(l => ({ name: l.split(/\s+/)[0], notNull: /NOT NULL/i.test(l.split('--')[0]), auto: /AUTOINCREMENT/.test(l) }));
}

// Deterministic choices, so a failing seed reproduces.
function prng(seed){
    let s = seed;
    return list => { s = (s * 1103515245 + 12345) % 2147483648; return list[s % list.length]; };
}

function poolFor(col, table){
    const name = col.name;
    let pool;
    if(name === 'action_index' || /_action_index$/.test(name)) pool = [1, 2, 3, 4, 5, 6, 7, 8];
    else if(name === 'block_index') pool = [100, 101, 102, 999];
    else if(name === 'tx_index') pool = [1, 2, 3, 77, null];
    else if(/_id$/.test(name)) pool = [1, 2, 3, 99, null];
    else if(table.startsWith('index_')) pool = ['X1', 'X2', 'X3', 'X4'];
    else pool = [0, 1, '1.5', null];
    return col.notNull ? pool.filter(v => v !== null) : pool;
}

function seedTable(sqlite, table, cols, pick){
    if(table.startsWith('index_')){
        const text = cols.find(c => !c.auto && c.notNull);
        for(let i = 1; i <= 4; i++)
            sqlite.prepare('INSERT INTO ' + table + ' (id, ' + text.name + ') VALUES (?, ?)').run(i, 'X' + i);
        return;
    }
    const insertable = cols.filter(c => !c.auto);
    const sql = 'INSERT INTO ' + table + ' (' + insertable.map(c => c.name).join(', ') + ') VALUES (' +
        insertable.map(() => '?').join(', ') + ')';
    for(let i = 0; i < ROWS_PER_TABLE; i++){
        try { sqlite.prepare(sql).run(...insertable.map(c => pick(poolFor(c, table)))); }
        catch(e){ if(!/UNIQUE/.test(e.message)) throw e; }
    }
}

function tablesOf(count){
    const parsed = parseCountSql(count);
    return [parsed.table].concat(parsed.joins.map(j => j.table));
}

let sqlite, db, loaded;

function ensureTable(table, pick){
    if(loaded.has(table)) return;
    const raw = fs.readFileSync(path.join(INDEXER_SQL_DIR, table + '.sql'), 'utf8');
    const lite = toSqlite(raw, table);
    sqlite.exec(lite);
    seedTable(sqlite, table, columnsOf(lite, table), pick);
    loaded.add(table);
}

async function buildCount(method, type, search){
    const config = makeConfig({ coin: 'BTC', type: 'api', data: { method, type, search, query: {} } });
    const [, args, count] = await db.getQuery(config);
    return { count, args: listQueryArgs(db, config, args) };
}

function outcome(sql, args){
    try { return sqlite.prepare(sql).all(...args)[0].total; }
    catch(e){ return 'error: ' + e.message; }
}

describe('pruned list COUNT against the REAL indexer DDL', function(){
    before(function(){
        const verdict = siblingCheckout(__dirname, path.join(INDEXER_SQL_DIR, 'issues.sql'));
        if(!verdict.usable) return skipOrFail(this, verdict, 'the pruned-count equivalence guard');
        let DatabaseSync;
        try { ({ DatabaseSync } = require('node:sqlite')); }
        catch(e){ return this.skip(); }
        sqlite = new DatabaseSync(':memory:');
        loaded = new Set();
        const configInfo = createConfigInfoStub();
        db = new Database({ configInfo, util: new Utility(configInfo) });
        db.doQuery = async () => [];
        db.getCanonicalTick = async (config, value) => value;
    });

    it('finds every pruned join key unique in the indexer DDL', function(){
        for(const [table, column] of Object.entries(UNIQUE_JOIN_KEYS)){
            const raw = fs.readFileSync(path.join(INDEXER_SQL_DIR, table + '.sql'), 'utf8');
            const pk = new RegExp('^\\s*' + column + '\\s+[^\\n]*PRIMARY KEY', 'm').test(raw);
            const unique = new RegExp('CREATE\\s+UNIQUE\\s+INDEX\\s+\\w+\\s+ON\\s+' + table + '\\s*\\(\\s*' + column + '\\s*\\)', 'i').test(raw);
            expect(pk || unique, table + '.' + column).to.equal(true);
        }
    });

    it('answers every list lane with the same total before and after pruning', async function(){
        const pick = prng(20261013);
        let pruned = 0, nonZero = 0;
        for(const method of METHODS){
            for(const [type, search] of LANES){
                const { count, args } = await buildCount(method, type, search);
                for(const table of tablesOf(count)) ensureTable(table, pick);
                const smaller = pruneCountJoins(count);
                const label = method + ' ' + type;
                expect(outcome(smaller, args), label).to.deep.equal(outcome(count, args));
                if(smaller !== count) pruned++;
                if(typeof outcome(count, args) === 'number' && outcome(count, args) > 0) nonZero++;
            }
        }
        // The comparison must have exercised real pruning on populated tables.
        expect(pruned).to.be.greaterThan(METHODS.length * 3);
        expect(nonZero).to.be.greaterThan(METHODS.length * 2);
    });
});
