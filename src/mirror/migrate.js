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
 * XChain Explorer - Hub-mirror schema drift reconciler
 *
 * ensureTables() (vendored in hub_db_sync.js) only CREATEs missing tables;
 * it never ALTERs an existing one. A mirror schema predating a column that
 * later landed therefore kept its legacy shape and every deploy needed a
 * manual ALTER TABLE, or the mirror client silently dropped the retraction
 * key on insert (columns are intersected against SHOW COLUMNS) and reorg
 * row:deleted events could never match.
 *
 * Migrated today: price_snapshots (source_chain, source_action_index,
 * push_generation + idx_source_chain), capability_snapshots (the uq_cap_snap
 * widen), the item-5308 reorg fences on oracle_prices, cross_chain_matches
 * and cross_chain_calls, the attestation_responses utf8mb4 widen, the
 * oracle_prices.tick length widen, and the later hub columns: the admission
 * heights (admit_block, admit_block_<chain>), btc_chain_id, batch_block_time and
 * batch_action_index.
 *
 * This module closes that gap: after ensureTables(), it probes each known
 * table with SHOW COLUMNS / SHOW FULL COLUMNS / SHOW INDEX and applies only
 * the ALTERs that are actually missing. Idempotent and probe-based (no
 * reliance on ALTER ... IF NOT EXISTS), so re-running is always safe.
 *
 * MONOTONIC ONLY. Every migration here either ADDs something, WIDENS an
 * existing thing, or RETYPEs TIMESTAMP to DATETIME. DATETIME holds every
 * TIMESTAMP value, and the UTC pin keeps each stored instant. No accepted value
 * stops being accepted. A narrowing has no place in this module: it would fail
 * on stored rows rather than convert them, and the mirror has no writer to
 * repair them from.
 *
 * It lives explorer-side (NOT in the vendored client) on purpose: the
 * canonical hub_db_sync.js in xchain-indexer is byte-identity-gated by
 * HubMirrorClientConformance.test.js, and the indexer's own verifyTables()
 * machinery already owns schema drift there.
 *
 * Externally-maintained mirror schemas (legacy single-server deployments
 * where the explorer only reads) don't pass through HubMirrorSyncManager;
 * run bin/migrate-hub-mirror.js against those instead (see that script's
 * header for the runbook).
 *
 ********************************************************************/

'use strict';

// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that. Named
// logger here because ensureMirrorColumns takes its own log callback.
const { getLogger } = require('../observability');
const logger = getLogger();

// Per-table additive migrations, kept in their own module (see mirror_migrations.js).
const { MIRROR_MIGRATIONS } = require('./mirror_migrations');

// Reconcile one mirror schema against MIRROR_MIGRATIONS. dbConn is any
// object exposing doQuery(sql, args) bound to the mirror schema (the same
// contract ensureTables() takes, e.g. HubMirrorPool). Missing tables are
// skipped, not created: table creation stays ensureTables()'s job, and
// ordering (ensureTables first) guarantees they exist on the embedded path.
// Returns the list of DDL statements applied, for logging/tests.
async function ensureMirrorColumns(dbConn, log) {
    log = log || ((msg) => logger.info('HUB_MIRROR_MIGRATION', { detail: msg }));
    const applied = [];
    for (const table of Object.keys(MIRROR_MIGRATIONS)) {
        const spec = MIRROR_MIGRATIONS[table];

        const existing = await dbConn.doQuery('SHOW TABLES LIKE ?', [table]);
        if (!existing || existing.length === 0) continue;

        await addMissingColumnsAndIndexes(dbConn, table, spec, log, applied);
        await widenColumnCharsets(dbConn, table, spec, log, applied);
        await widenColumnLengths(dbConn, table, spec, log, applied);
        await widenUniqueIndexes(dbConn, table, spec, log, applied);
        await retypeColumnTypes(dbConn, table, spec, log, applied);
    }
    return applied;
}

// Add every column and index the table lacks by name, in one ALTER. Each step
// below takes the same (dbConn, table, spec, log, applied) and appends what it
// ran to `applied`.
async function addMissingColumnsAndIndexes(dbConn, table, spec, log, applied) {
    // SHOW COLUMNS rows carry the column name in `Field`; SHOW INDEX rows
    // carry the index name in `Key_name`. Lowercase both sides: column
    // identifiers are case-insensitive in MariaDB.
    const colRows = await dbConn.doQuery('SHOW COLUMNS FROM `' + table + '`');
    const have = new Set((colRows || []).map((r) => String(r.Field).toLowerCase()));

    const clauses = [];
    const restamp = [];
    for (const col of spec.columns) {
        if (have.has(col.name.toLowerCase())) continue;
        clauses.push(col.ddl);
        if (col.restamp) restamp.push(col.name);
    }
    if (spec.indexes && spec.indexes.length) {
        const idxRows = await dbConn.doQuery('SHOW INDEX FROM `' + table + '`');
        const haveIdx = new Set((idxRows || []).map((r) => String(r.Key_name).toLowerCase()));
        for (const idx of spec.indexes) {
            if (!haveIdx.has(idx.name.toLowerCase())) clauses.push(idx.ddl);
        }
    }
    if (clauses.length > 0) {
        // One ALTER per table so MariaDB rebuilds it at most once.
        const sql = 'ALTER TABLE `' + table + '` ' + clauses.join(', ');
        log('[hub-mirror] migrating ' + table + ': ' + clauses.join('; ') + restampNote(restamp));
        await dbConn.doQuery(sql);
        applied.push(sql);
    }
}

// Name the added columns whose values existing rows lack, so the log says the table needs a rebuild.
function restampNote(names) {
    if (names.length === 0) return '';
    return ' (rows already stored keep NULL or 0 in ' + names.join(', ') +
        '; rebuild this mirror table from the hub to restamp them)';
}

// Widen an existing column's character set. SHOW FULL COLUMNS carries the live
// Collation, which SHOW COLUMNS above does not, and the collation name is prefixed
// by its charset ('utf8mb4_general_ci'), so one probe answers both. Only ever
// widens, so no stored value is rewritten (utf8mb3 is a strict subset of utf8mb4)
// and no accepted value stops being accepted. Idempotent: a no-op once the live
// collation already sits on the target charset.
async function widenColumnCharsets(dbConn, table, spec, log, applied) {
    if (!(spec.widenColumns && spec.widenColumns.length)) return;
    const fullRows = await dbConn.doQuery('SHOW FULL COLUMNS FROM `' + table + '`');
    const collation = new Map((fullRows || []).map(
        (r) => [String(r.Field).toLowerCase(), String(r.Collation || '').toLowerCase()]));
    const widenClauses = [];
    for (const w of spec.widenColumns) {
        const live = collation.get(String(w.name).toLowerCase());
        if (live === undefined) continue;                        // column absent: ensureTables owns it
        if (live.startsWith(String(w.charset).toLowerCase() + '_')) continue;  // already widened
        widenClauses.push(w.ddl);
    }
    if (widenClauses.length > 0) {
        const sql = 'ALTER TABLE `' + table + '` ' + widenClauses.join(', ');
        log('[hub-mirror] widening ' + table + ': ' + widenClauses.join('; '));
        await dbConn.doQuery(sql);
        applied.push(sql);
    }
}

// Widen an existing VARCHAR column's length. SHOW COLUMNS carries the live Type
// ('varchar(50)'); an absent or unreadable Type is skipped, never guessed at. Only ever
// widens. A failed ALTER is logged rather than thrown: the hub holds longer values back
// until the operator attests the mirrors are wide, so a narrow column is safe to start on.
async function widenColumnLengths(dbConn, table, spec, log, applied) {
    if (!(spec.widenLengths && spec.widenLengths.length)) return;
    const rows = await dbConn.doQuery('SHOW COLUMNS FROM `' + table + '`');
    const types = new Map((rows || []).map((r) => [String(r.Field).toLowerCase(), String(r.Type || '').toLowerCase()]));
    const clauses = [];
    for (const w of spec.widenLengths) {
        const m = /^(?:var)?char\((\d+)\)/.exec(types.get(String(w.name).toLowerCase()) || '');
        if (!m || Number(m[1]) >= w.length) continue;             // absent, unreadable or already wide
        clauses.push(w.ddl);
    }
    if (clauses.length === 0) return;
    const sql = 'ALTER TABLE `' + table + '` ' + clauses.join(', ');
    try {
        log('[hub-mirror] widening ' + table + ': ' + clauses.join('; '));
        await dbConn.doQuery(sql);
        applied.push(sql);
    } catch (err) {
        logger.error('HUB_MIRROR_WIDEN_FAILED', { table, err: err && err.message ? err.message : err,
            run_by_hand: sql + ' (the hub must not widen this column until it has applied)' });
    }
}

// Retype allowlisted columns only when the live type matches the declared source.
// The UTC pin and ALTER share a statement because doQuery may use a new connection.
async function retypeColumnTypes(dbConn, table, spec, log, applied) {
    if (!(spec.retypeColumns && spec.retypeColumns.length)) return;
    const rows = await dbConn.doQuery('SHOW COLUMNS FROM `' + table + '`');
    const types = new Map((rows || []).map(
        (r) => [String(r.Field).toLowerCase(), String(r.Type || '').toLowerCase()]));
    const clauses = [];
    for (const column of spec.retypeColumns) {
        const live = types.get(String(column.name).toLowerCase()) || '';
        if (!live.startsWith(String(column.from).toLowerCase())) continue;
        clauses.push(column.ddl);
    }
    if (clauses.length === 0) return;
    const sql = "SET STATEMENT time_zone = '+00:00' FOR ALTER TABLE `" + table + '` ' + clauses.join(', ');
    try {
        log('[hub-mirror] retyping ' + table + ': ' + clauses.join('; '));
        await dbConn.doQuery(sql);
        applied.push(sql);
    } catch (err) {
        logger.error('HUB_MIRROR_RETYPE_FAILED', {
            table,
            err: err && err.message ? err.message : err,
            run_by_hand: sql
        });
    }
}

// Widen an existing UNIQUE key whose column set changed. Probe the
// live index columns; if the required column is absent, drop and re-add the
// wider key. Separate DROP then ADD so the re-add never races the drop. Only
// ever widens (adds a column), so an already-unique table cannot collide and
// no row dedup is needed. Idempotent: a no-op once the key already covers it.
async function widenUniqueIndexes(dbConn, table, spec, log, applied) {
    if (!(spec.widenIndexes && spec.widenIndexes.length)) return;
    const idxRows = await dbConn.doQuery('SHOW INDEX FROM `' + table + '`');
    for (const w of spec.widenIndexes) {
        const cols = (idxRows || [])
            .filter((r) => String(r.Key_name).toLowerCase() === w.name.toLowerCase())
            .map((r) => String(r.Column_name).toLowerCase());
        if (cols.length === 0) continue;                                     // index absent: indexes/ensureTables owns it
        if (cols.includes(String(w.requiredColumn).toLowerCase())) continue; // already widened
        log('[hub-mirror] widening ' + table + '.' + w.name + ' to include ' + w.requiredColumn);
        await dbConn.doQuery('ALTER TABLE `' + table + '` DROP INDEX `' + w.name + '`');
        await dbConn.doQuery('ALTER TABLE `' + table + '` ' + w.addDdl);
        applied.push('ALTER TABLE `' + table + '` ' + w.addDdl);
    }
}

module.exports = { ensureMirrorColumns, MIRROR_MIGRATIONS };
