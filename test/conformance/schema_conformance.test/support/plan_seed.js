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
 * Seeds every base table of a schema with SEED_ROWS synthetic rows so the
 * optimizer plans against populated tables, then refreshes their statistics.
 *
 * On empty or one-row tables MariaDB picks a full scan whenever it is cheap,
 * which says nothing about production. Seeding is chosen over injecting fake
 * engine-independent statistics because writing mysql.table_stats needs
 * privileges a CI venue identity does not have (it owns only its ci_* schemas);
 * INSERT ... SELECT FROM the SEQUENCE engine plus ANALYZE TABLE runs under the
 * same grants as the DDL load.
 *
 * Every column takes the row number (as a number, a string, or a time), so ids
 * join across tables, every lookup value exists, and every equality is
 * selective. That bias favours indexes: a plan that still reads a seeded table
 * whole has no index that serves it. Values that overflow a narrow column are
 * clipped, and rows that then collide on a unique key are dropped.
 *
 ********************************************************************/

'use strict';

const SEED_ROWS = 1000;

// Tables large in production. The explicit names are the per-action and
// lookup tables a production explorer reads most; every table that declares an
// action_index column is per-action and joins this set at run time.
const LISTED_LARGE_TABLES = [
    'actions', 'transactions', 'issues', 'sends', 'mappings_actions', 'tokens',
    'index_addresses', 'index_tickers', 'state_tree_roots', 'price_snapshots',
    'order_matches', 'swap_matches', 'blocks'
];

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint',
    'decimal', 'float', 'double', 'year']);
const TEMPORAL = new Set(['date', 'datetime', 'timestamp']);
const SKIPPED = new Set(['enum', 'set', 'geometry', 'point', 'linestring', 'polygon',
    'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection']);

/** The SELECT expression that fills one column from the sequence's `seq`. */
function seedExpression(dataType) {
    const type = String(dataType).toLowerCase();
    if (SKIPPED.has(type)) return null;
    if (NUMERIC.has(type)) return 'seq';
    if (type === 'bit') return 'seq % 2';
    if (TEMPORAL.has(type)) return 'FROM_UNIXTIME(1700000000 + seq * 600)';
    if (type === 'time') return 'SEC_TO_TIME(seq)';
    return 'CAST(seq AS CHAR)';
}

/** One INSERT ... SELECT for a table, or null when no column can be filled. */
function seedStatement(dbName, table, columns, rows) {
    const filled = columns
        .filter((c) => !/GENERATED/i.test(c.extra || ''))
        .map((c) => ({ name: c.name, expr: seedExpression(c.dataType) }))
        .filter((c) => c.expr !== null);
    if (!filled.length) return null;
    return 'INSERT IGNORE INTO `' + dbName + '`.`' + table + '` (' +
        filled.map((c) => '`' + c.name + '`').join(', ') + ') SELECT ' +
        filled.map((c) => c.expr).join(', ') + ' FROM seq_1_to_' + rows;
}

async function schemaColumns(conn, dbName) {
    const rows = await conn.query(
        'SELECT c.TABLE_NAME AS tableName, c.COLUMN_NAME AS name, c.DATA_TYPE AS dataType, c.EXTRA AS extra ' +
        'FROM information_schema.COLUMNS c INNER JOIN information_schema.TABLES t ' +
        'ON (t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME) ' +
        "WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
        [dbName]);
    const byTable = new Map();
    for (const r of rows) {
        if (!byTable.has(r.tableName)) byTable.set(r.tableName, []);
        byTable.get(r.tableName).push(r);
    }
    return byTable;
}

/**
 * Seeds every base table in `dbName` and refreshes its statistics. Returns the
 * tables that could not be seeded with the server's reason.
 */
async function seedSchema(pool, dbName, rows = SEED_ROWS) {
    const conn = await pool.getConnection();
    const failures = [];
    try {
        await conn.query('USE `' + dbName + '`');
        await conn.query("SET SESSION sql_mode='', foreign_key_checks=0");
        try { await conn.query('SET SESSION check_constraint_checks=0'); }
        catch (e) { /* older servers lack the switch; CHECK failures then drop rows */ }
        const tables = await schemaColumns(conn, dbName);
        for (const [table, columns] of tables) {
            const stmt = seedStatement(dbName, table, columns, rows);
            if (!stmt) continue;
            try { await conn.query(stmt); }
            catch (e) { failures.push(table + ': ' + e.message.split('\n')[0]); }
        }
        const names = [...tables.keys()].map((t) => '`' + dbName + '`.`' + t + '`');
        for (let i = 0; i < names.length; i += 50)
            await conn.query('ANALYZE TABLE ' + names.slice(i, i + 50).join(', '));
    } finally {
        conn.release();
    }
    return failures;
}

/** The production-large table set: the listed names plus every per-action table. */
async function largeTables(pool, dbNames) {
    const rows = await pool.query(
        "SELECT DISTINCT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE COLUMN_NAME='action_index' " +
        'AND TABLE_SCHEMA IN (?)', [dbNames]);
    return new Set(LISTED_LARGE_TABLES.concat(rows.map((r) => r.name)));
}

module.exports = { SEED_ROWS, LISTED_LARGE_TABLES, seedExpression, seedStatement, seedSchema, largeTables };
