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
 * XChain Explorer - Hub-mirror additive migration table
 *
 * The per-table list ensureMirrorColumns() in migrate.js reconciles a live
 * mirror schema against. Kept apart from the reconciler so the data and the
 * code that applies it stay readable on their own; migrate.js re-exports it.
 *
 ********************************************************************/

'use strict';

// Per-table list of additive column/index migrations. Definitions are kept
// byte-equivalent to the twin CREATE TABLE files in src/sql/hub-mirror/ so a
// migrated legacy table converges on the same shape a fresh ensureTables()
// build gets. A column marked restamp carries a value the hub stamps on insert,
// so rows stored before the ALTER keep NULL (or 0) until the table is rebuilt
// from the hub (most mirror writes are INSERT IGNORE); the log line names them.
const MIRROR_MIGRATIONS = {
    price_snapshots: {
        columns: [
            { name: 'source_chain',        ddl: "ADD COLUMN source_chain VARCHAR(10) NOT NULL DEFAULT 'DOGE'" },
            { name: 'source_action_index', ddl: 'ADD COLUMN source_action_index BIGINT' },
            { name: 'push_generation',     ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'batch_block_time',    ddl: 'ADD COLUMN batch_block_time BIGINT NOT NULL DEFAULT 0', restamp: true },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true }
        ],
        indexes: [
            { name: 'idx_source_chain', ddl: 'ADD KEY idx_source_chain (source_chain)' }
        ],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    // Fence the three twins the same item-5308 rollout touched. applyRetraction
    // fences from the incoming event, not from local columns, so a missing one throws.
    // Carry finalizing_view too (applyRow intersects against SHOW COLUMNS, so a
    // missing column is dropped from the insert without a word).
    // Use no AFTER anchors, as price_snapshots above does not: order is cosmetic
    // here, and an anchor absent from an old schema fails the whole single ALTER.
    oracle_prices: {
        columns: [
            { name: 'push_generation', ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'admit_block',     ddl: 'ADD COLUMN admit_block BIGINT UNSIGNED DEFAULT NULL', restamp: true }
        ],
        indexes: [],
        // tick widens to the 250 PRICE v1 admits. The hub keeps its own column narrow until
        // the operator attests every mirror has widened, so this runs first; a strict mirror
        // left at VARCHAR(50) would refuse a longer tick and wedge on every re-page.
        widenLengths: [
            { name: 'tick', length: 250, ddl: 'MODIFY `tick` VARCHAR(250) NOT NULL' }
        ],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    cross_chain_matches: {
        columns: [
            { name: 'finalizing_view',   ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'a_push_generation', ddl: 'ADD COLUMN a_push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'b_push_generation', ddl: 'ADD COLUMN b_push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64)' }
        ],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    cross_chain_calls: {
        columns: [
            { name: 'finalizing_view', ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'push_generation', ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64)' }
        ],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp',
              ddl: 'MODIFY `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    // The two bridge mirror twins carry the same fence pair as cross_chain_calls
    // above, for the same reason: applyRetraction fences from the incoming event,
    // so a mirror missing push_generation throws on a retraction, and applyRow
    // intersects against SHOW COLUMNS, so a missing finalizing_view is dropped from
    // the insert silently and the EQUIV header can no longer be rebuilt. A mirror
    // that predates these tables gets them from ensureTables(); these entries are
    // for the legacy case where the table exists but was created before the fence
    // columns did. No AFTER anchors, matching every entry above.
    bridge_transfers: {
        columns: [
            { name: 'finalizing_view', ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'push_generation', ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64)' }
        ],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    policy_snapshots: {
        columns: [
            { name: 'finalizing_view', ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'push_generation', ddl: 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0' },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64)' }
        ],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    // uq_cap_snap gained `source` (a key delegated by two sources now keeps
    // both (source, pubkey) rows). The add-if-name-missing logic above cannot widen
    // an existing same-named index, so capability_snapshots uses widenIndexes: if the
    // live uq_cap_snap does not already cover `source`, drop and re-add it with the
    // 4-column key. Widening an already-enforced UNIQUE key is monotonically safe (it
    // can only relax the constraint), so no row dedup is needed.
    capability_snapshots: {
        columns: [
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64)' }
        ],
        indexes: [],
        widenIndexes: [
            { name: 'uq_cap_snap', requiredColumn: 'source',
              addDdl: 'ADD UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey, source)' }
        ],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp', ddl: 'MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    state_checkpoints: {
        columns: [],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp',
              ddl: 'MODIFY `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    anchor_reward_attestations: {
        columns: [],
        indexes: [],
        retypeColumns: [
            { name: 'created_at', from: 'timestamp',
              ddl: 'MODIFY `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' }
        ]
    },
    // attestation_responses.response_payload / meta hold the PROVIDER bytes of a
    // finalized ATTEST response, and the on-chain columns that response stands in for
    // are utf8mb4. On a mirror still carrying the table's utf8mb3 tail a body with one
    // 4-byte character fails the apply INSERT (errno 1366 under STRICT_TRANS_TABLES)
    // and, because that table re-pages from cursor 0, is re-delivered and re-refused on
    // every drain rather than skipped once. ensureTables gives a FRESH mirror the
    // charset from the twin file; widenColumns is what reaches one that already exists.
    // uq_attest_response gained `effective_time`: one request can finalize under two
    // leader slots and yield two honestly signed rows that differ only in the stamp,
    // and the indexer binds the smaller one. Same widen shape as uq_cap_snap above.
    attestation_responses: {
        columns: [
            { name: 'admit_block_btc',    ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'batch_action_index', ddl: 'ADD COLUMN batch_action_index BIGINT UNSIGNED DEFAULT NULL', restamp: true }
        ],
        indexes: [],
        widenIndexes: [
            { name: 'uq_attest_response', requiredColumn: 'effective_time',
              addDdl: 'ADD UNIQUE KEY uq_attest_response (network, request_id, effective_time)' }
        ],
        widenColumns: [
            { name: 'response_payload', charset: 'utf8mb4',
              ddl: 'MODIFY `response_payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci' },
            { name: 'meta', charset: 'utf8mb4',
              ddl: 'MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci' }
        ]
    },
    remote_token_snapshots: {
        columns: [
            { name: 'finalizing_view', ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64) NULL' }
        ],
        indexes: []
    },
    list_snapshots: {
        columns: [
            { name: 'finalizing_view', ddl: 'ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0' },
            { name: 'name', ddl: 'ADD COLUMN name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER members_hash' },
            { name: 'description', ddl: 'ADD COLUMN description VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER name' },
            { name: 'meta_hash', ddl: 'ADD COLUMN meta_hash CHAR(64) NULL AFTER description' },
            { name: 'admit_block_btc',  ddl: 'ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_ltc',  ddl: 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'admit_block_doge', ddl: 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL', restamp: true },
            { name: 'btc_chain_id', ddl: 'ADD COLUMN btc_chain_id CHAR(64) NULL' }
        ],
        indexes: []
    }
};

module.exports = { MIRROR_MIGRATIONS };
