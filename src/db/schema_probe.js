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
 * XChain Explorer - what the connected replica actually holds
 *
 * The explorer serves whichever indexer replica it is pointed at, and a replica
 * takes the indexer's manual migrations on the operator's schedule, not the
 * explorer's release schedule. A statement that names a table the connected schema
 * does not carry is MariaDB error 1146 for the WHOLE statement, so a reader that
 * assumes the newest schema answers 500 on every request instead of answering the
 * part of the page that schema can serve.
 *
 * This is the shared table and column probe those readers ask first (a statement
 * naming a column the schema lacks is error 1054, the same whole-statement failure). It is deliberately not a
 * feature flag: the answer is a property of the connected schema, read from it, so
 * a replica that takes the migration later is served correctly with no config
 * change and no restart.
 *
 ********************************************************************/

'use strict';

// How long a NEGATIVE probe is trusted. A positive answer is kept for the life of
// the process (a table cannot vanish from under a running explorer), a negative one
// expires so that applying the migration heals the route by itself rather than
// needing the service restarted.
const SCHEMA_PROBE_TTL_MS = 60000;

// One memo key per table set, so two readers asking about different tables never
// answer for each other.
function memoKey(tables){
    return tables.slice().sort().join(',');
}

// The per-coin memo bucket, created on first use. Keyed by coin because the pool a
// read runs on is picked by coin, and two coins are two schemas.
function memoBucket(db, config){
    if(!db.schemaTableMemo) db.schemaTableMemo = {};
    const coin = config.coin;
    if(!db.schemaTableMemo[coin]) db.schemaTableMemo[coin] = {};
    return db.schemaTableMemo[coin];
}

// Whether the connected schema carries EVERY named table, memoized per coin rather
// than asked per request: an information_schema round trip on every page would buy
// nothing, because the answer only changes when an operator applies a migration.
// DATABASE() rather than the pool's configured name, so the answer is about the
// schema the read itself lands in.
//
// A probe that ITSELF fails answers true, which is the behaviour before any probe
// existed, and caches nothing. Callers pair this with isMissingTableError below, so
// a wrong answer costs one failed statement and never the route.
async function tablesPresent(db, config, tables){
    const bucket = memoBucket(db, config);
    const key    = memoKey(tables);
    const memo   = bucket[key];
    if(memo && (memo.present || (Date.now() - memo.at) < SCHEMA_PROBE_TTL_MS))
        return memo.present;
    try {
        const placeholders = tables.map(() => '?').join(',');
        const rows = await db.doQuery(config,
            `SELECT TABLE_NAME
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${placeholders})`, tables);
        const found   = new Set((rows || []).map(r => String(r.TABLE_NAME)));
        const present = tables.every(name => found.has(name));
        bucket[key] = { present, at: Date.now() };
        return present;
    } catch(e){
        return true;
    }
}

// Record that the connected schema does NOT carry these tables, after a statement
// proved it. Called from a caller's 1146 recovery so the next read skips the
// statement that cannot work, instead of paying the same error again.
function setTablesAbsent(db, config, tables){
    memoBucket(db, config)[memoKey(tables)] = { present: false, at: Date.now() };
}

// MariaDB error 1146 (ER_NO_SUCH_TABLE), "Table ... doesn't exist", as it arrives
// through doQuery, which wraps the driver's error as the `cause` of a DbQueryError.
// Matched on the numeric errno as well as the name because the two spellings come
// from different layers of the driver and only the number is stable.
function isMissingTableError(err){
    const cause = (err && err.cause) ? err.cause : err;
    return Number(cause && cause.errno) === 1146 || (cause && cause.code) === 'ER_NO_SUCH_TABLE';
}

// The per-coin column memo bucket, kept apart from the table memo so a column set
// and a table set can never answer for each other.
function columnBucket(db, config){
    if(!db.schemaColumnMemo) db.schemaColumnMemo = {};
    const coin = config.coin;
    if(!db.schemaColumnMemo[coin]) db.schemaColumnMemo[coin] = {};
    return db.schemaColumnMemo[coin];
}

// Whether `table` on the connected schema carries EVERY named column, on the same
// terms as tablesPresent: memoized per coin, a negative answer aging out on the TTL,
// and a probe that itself fails answering true and caching nothing. Callers pair
// this with isUnknownColumnError below.
async function columnsPresent(db, config, table, columns){
    const bucket = columnBucket(db, config);
    const key    = table + ':' + memoKey(columns);
    const memo   = bucket[key];
    if(memo && (memo.present || (Date.now() - memo.at) < SCHEMA_PROBE_TTL_MS))
        return memo.present;
    try {
        const placeholders = columns.map(() => '?').join(',');
        const rows = await db.doQuery(config,
            `SELECT COLUMN_NAME
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME IN (${placeholders})`,
            [table].concat(columns));
        const found   = new Set((rows || []).map(r => String(r.COLUMN_NAME)));
        const present = columns.every(name => found.has(name));
        bucket[key] = { present, at: Date.now() };
        return present;
    } catch(e){
        return true;
    }
}

// Record that `table` does NOT carry these columns, after a statement proved it.
function setColumnsAbsent(db, config, table, columns){
    columnBucket(db, config)[table + ':' + memoKey(columns)] = { present: false, at: Date.now() };
}

// MariaDB error 1054 (ER_BAD_FIELD_ERROR), "Unknown column", unwrapped from doQuery's
// DbQueryError the same way isMissingTableError unwraps 1146.
function isUnknownColumnError(err){
    const cause = (err && err.cause) ? err.cause : err;
    return Number(cause && cause.errno) === 1054 || (cause && cause.code) === 'ER_BAD_FIELD_ERROR';
}

module.exports = {
    SCHEMA_PROBE_TTL_MS,
    tablesPresent,
    setTablesAbsent,
    isMissingTableError,
    columnsPresent,
    setColumnsAbsent,
    isUnknownColumnError
};
