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
 * The additive column and index list is no longer hand-copied: it is read from
 * the CREATE TABLE twins in src/sql/hub-mirror/ the way ensureTables() reads
 * them. Only the widen and retype steps, which a twin cannot express, are
 * written out below.
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

const fs = require('fs');
const path = require('path');
const { parseDeclaredColumns, parseDeclaredIndexes } = require('../hub/hub_db_sync/ensure_tables');

// The CREATE TABLE twins are the single source of every column definition and index
// declaration, read the way ensureTables() reads them. Below lists only WHICH twin
// columns and keys a legacy mirror is migrated to (names, never DDL), so a definition
// cannot drift from its twin the way a hand-copied one did.
const TWIN_DIR = path.join(__dirname, '..', 'sql', 'hub-mirror');

const ADMIT = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
const ADDITIVE = {
    price_snapshots: {
        columns: ['source_chain', 'source_action_index', 'push_generation', 'batch_block_time'].concat(ADMIT),
        indexes: ['idx_source_chain']
    },
    // Fence the twins the same item-5308 rollout touched. applyRetraction fences from the
    // incoming event, not from local columns, so a missing one throws; applyRow intersects
    // against SHOW COLUMNS, so a missing finalizing_view is dropped from the insert silently.
    oracle_prices: { columns: ['push_generation', 'admit_block'] },
    cross_chain_matches: {
        columns: ['finalizing_view', 'a_push_generation', 'b_push_generation'].concat(ADMIT, 'btc_chain_id')
    },
    cross_chain_calls: { columns: ['finalizing_view', 'push_generation'].concat(ADMIT, 'btc_chain_id') },
    bridge_transfers: { columns: ['finalizing_view', 'push_generation'].concat(ADMIT, 'btc_chain_id') },
    policy_snapshots: { columns: ['finalizing_view', 'push_generation'].concat(ADMIT, 'btc_chain_id') },
    capability_snapshots: { columns: ['btc_chain_id'] },
    attestation_responses: { columns: ['admit_block_btc', 'batch_action_index'] },
    remote_token_snapshots: { columns: ['finalizing_view'].concat(ADMIT, 'btc_chain_id') },
    // anchored: placed AFTER the preceding twin column, which every legacy shape carries.
    list_snapshots: {
        columns: ['finalizing_view', 'name', 'description', 'meta_hash'].concat(ADMIT, 'btc_chain_id'),
        anchored: ['name', 'description', 'meta_hash']
    }
};

// Columns the hub stamps on insert: rows stored before the ALTER keep NULL (or 0) until
// the table is rebuilt from the hub (most mirror writes are INSERT IGNORE); the log
// line names them.
const RESTAMPED = /^(admit_block(_[a-z]+)?|batch_block_time|batch_action_index)$/;

// Everything that is not a plain ADD COLUMN / ADD KEY, which the twins cannot express
// because they describe the target shape, not the step from a past one. Each entry is
// monotonic: it widens or retypes, never narrows.
const NON_ADDITIVE = {
    price_snapshots: { retypeColumns: [retypeCreatedAt('')] },
    // tick widens to the 250 PRICE v1 admits. The hub keeps its own column narrow until
    // the operator attests every mirror has widened, so this runs first; a strict mirror
    // left at VARCHAR(50) would refuse a longer tick and wedge on every re-page.
    oracle_prices: {
        widenLengths: [{ name: 'tick', length: 250, ddl: 'MODIFY `tick` VARCHAR(250) NOT NULL' }],
        retypeColumns: [retypeCreatedAt('')]
    },
    cross_chain_matches: { retypeColumns: [retypeCreatedAt('')] },
    cross_chain_calls: { retypeColumns: [retypeCreatedAt(' NOT NULL')] },
    bridge_transfers: { retypeColumns: [retypeCreatedAt('')] },
    policy_snapshots: { retypeColumns: [retypeCreatedAt('')] },
    // uq_cap_snap gained `source` (a key delegated by two sources now keeps both
    // (source, pubkey) rows). Widening an already-enforced UNIQUE key only relaxes it, so
    // no row dedup is needed.
    capability_snapshots: {
        widenIndexes: [{ name: 'uq_cap_snap', requiredColumn: 'source',
            addDdl: 'ADD UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey, source)' }],
        retypeColumns: [retypeCreatedAt('')]
    },
    state_checkpoints: { retypeColumns: [retypeCreatedAt(' NOT NULL')] },
    anchor_reward_attestations: { retypeColumns: [retypeCreatedAt(' NOT NULL')] },
    // response_payload / meta hold PROVIDER bytes and their on-chain twins are utf8mb4;
    // ensureTables gives a FRESH mirror the charset, widenColumns reaches an existing one.
    // uq_attest_response gained `effective_time`: one request can finalize under two
    // leader slots, so the key must tell the two honestly signed rows apart.
    attestation_responses: {
        widenIndexes: [{ name: 'uq_attest_response', requiredColumn: 'effective_time',
            addDdl: 'ADD UNIQUE KEY uq_attest_response (network, request_id, effective_time)' }],
        widenColumns: [
            { name: 'response_payload', charset: 'utf8mb4',
              ddl: 'MODIFY `response_payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci' },
            { name: 'meta', charset: 'utf8mb4',
              ddl: 'MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci' }
        ]
    }
};

function retypeCreatedAt(constraint) {
    return { name: 'created_at', from: 'timestamp',
        ddl: 'MODIFY `created_at` DATETIME' + constraint + ' DEFAULT CURRENT_TIMESTAMP' };
}

// Build the per-table migration spec from the twins. A listed name the twin does not
// declare is a bug in the list above and throws at load rather than migrating nothing.
function loadMirrorMigrations(dir) {
    const migrations = {};
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        const table = file.slice(0, -'.sql'.length);
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const declared = parseDeclaredColumns(sql) || [];
        const wanted = ADDITIVE[table] || {};
        const byName = new Map(declared.map((c) => [c.name, c]));
        const byIndex = new Map(parseDeclaredIndexes(sql, table).map((i) => [i.name, i]));
        migrations[table] = Object.assign({
            declaredNames: declared.map((c) => c.name),
            columns: (wanted.columns || []).map((name) => {
                const c = byName.get(name);
                if (!c) throw new Error('migrate: ' + table + '.' + name + ' is not declared in its twin');
                const definition = c.definition.replace(/\s+/g, ' ');
                return { name, definition, ddl: 'ADD COLUMN ' + definition, restamp: RESTAMPED.test(name),
                    anchored: (wanted.anchored || []).includes(name) };
            }),
            indexes: (wanted.indexes || []).map((name) => {
                const i = byIndex.get(name);
                if (!i) throw new Error('migrate: ' + table + '.' + name + ' is not declared in its twin');
                return { name, ddl: 'ADD KEY ' + name + ' (' + i.cols + ')' };
            })
        }, NON_ADDITIVE[table]);
    }
    return migrations;
}

const MIRROR_MIGRATIONS = loadMirrorMigrations(TWIN_DIR);

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
        clauses.push(col.ddl + (col.anchored ? anchorFor(spec, col) : ''));
        have.add(col.name.toLowerCase());
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

// Place an anchored column directly after its predecessor in the twin. Only columns
// listed as anchored use this: an anchor absent from an old schema fails the whole
// single ALTER, so it is reserved for predecessors every legacy shape carries or that
// this same ALTER adds just before it.
function anchorFor(spec, col) {
    const i = spec.declaredNames.indexOf(col.name);
    return i > 0 ? ' AFTER ' + spec.declaredNames[i - 1] : '';
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
