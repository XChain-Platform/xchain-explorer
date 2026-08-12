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
 * it never ALTERs an existing one. A mirror schema created before the
 * price_snapshots reorg-retraction columns landed (source_chain,
 * source_action_index, push_generation + idx_source_chain) therefore kept
 * its legacy shape and every deploy needed a manual ALTER TABLE, or the
 * mirror client silently dropped the retraction key on insert (columns are
 * intersected against SHOW COLUMNS) and reorg row:deleted events could
 * never match.
 *
 * This module closes that gap: after ensureTables(), it probes each known
 * table with SHOW COLUMNS / SHOW INDEX and applies only the ALTERs that
 * are actually missing. Additive-only, idempotent, and probe-based (no
 * reliance on ALTER ... IF NOT EXISTS), so re-running is always safe.
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

// Per-table list of additive column/index migrations. Definitions are kept
// byte-equivalent to the twin CREATE TABLE files in src/sql/hub-mirror/ so a
// migrated legacy table converges on the same shape a fresh ensureTables()
// build gets.
const MIRROR_MIGRATIONS = {
    price_snapshots: {
        columns: [
            { name: 'source_chain',        ddl: "ADD COLUMN source_chain VARCHAR(10) NOT NULL DEFAULT 'DOGE'" },
            { name: 'source_action_index', ddl: 'ADD COLUMN source_action_index BIGINT' },
            { name: 'push_generation',     ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' }
        ],
        indexes: [
            { name: 'idx_source_chain', ddl: 'ADD KEY idx_source_chain (source_chain)' }
        ]
    },
    // uq_cap_snap gained `source` (a key delegated by two sources now keeps
    // both (source, pubkey) rows). The add-if-name-missing logic above cannot widen
    // an existing same-named index, so capability_snapshots uses widenIndexes: if the
    // live uq_cap_snap does not already cover `source`, drop and re-add it with the
    // 4-column key. Widening an already-enforced UNIQUE key is monotonically safe (it
    // can only relax the constraint), so no row dedup is needed.
    capability_snapshots: {
        columns: [],
        indexes: [],
        widenIndexes: [
            { name: 'uq_cap_snap', requiredColumn: 'source',
              addDdl: 'ADD UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey, source)' }
        ]
    }
};

// Reconcile one mirror schema against MIRROR_MIGRATIONS. dbConn is any
// object exposing doQuery(sql, args) bound to the mirror schema (the same
// contract ensureTables() takes, e.g. HubMirrorPool). Missing tables are
// skipped, not created: table creation stays ensureTables()'s job, and
// ordering (ensureTables first) guarantees they exist on the embedded path.
// Returns the list of DDL statements applied, for logging/tests.
async function ensureMirrorColumns(dbConn, log) {
    log = log || ((msg) => console.log(msg));
    const applied = [];
    for (const table of Object.keys(MIRROR_MIGRATIONS)) {
        const spec = MIRROR_MIGRATIONS[table];

        const existing = await dbConn.doQuery('SHOW TABLES LIKE ?', [table]);
        if (!existing || existing.length === 0) continue;

        // SHOW COLUMNS rows carry the column name in `Field`; SHOW INDEX rows
        // carry the index name in `Key_name`. Lowercase both sides: column
        // identifiers are case-insensitive in MariaDB.
        const colRows = await dbConn.doQuery('SHOW COLUMNS FROM `' + table + '`');
        const have = new Set((colRows || []).map((r) => String(r.Field).toLowerCase()));

        const clauses = [];
        for (const col of spec.columns) {
            if (!have.has(col.name.toLowerCase())) clauses.push(col.ddl);
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
            log('[hub-mirror] migrating ' + table + ': ' + clauses.join('; '));
            await dbConn.doQuery(sql);
            applied.push(sql);
        }

        // Widen an existing UNIQUE key whose column set changed. Probe the
        // live index columns; if the required column is absent, drop and re-add the
        // wider key. Separate DROP then ADD so the re-add never races the drop. Only
        // ever widens (adds a column), so an already-unique table cannot collide and
        // no row dedup is needed. Idempotent: a no-op once the key already covers it.
        if (spec.widenIndexes && spec.widenIndexes.length) {
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
    }
    return applied;
}

module.exports = { ensureMirrorColumns, MIRROR_MIGRATIONS };
