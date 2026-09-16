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
 * XChain Explorer - quorum-signed checkpoint and reward-attestation reads
 *
 * One part of src/db/readers/checkpoints.js (the entry composes it through
 * composeReaderParts). The checkpoint list, detail and verify reads, the
 * latest-checkpoint_seq-per-height predicate they all share, the reward
 * attestation list, and the three signed-checkpoint lookups SPV proof serving
 * binds a proof to.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

class CheckpointRowReaders {
    // Quorum-signed state checkpoints (hub-mirrored state_checkpoints table).
    // blockIndex null → latest N (one per height: MAX(checkpoint_seq) wins);
    // blockIndex set → that height's latest-seq row only.
    async getCheckpointRows(config, blockIndex, limit) {
        let src = this.checkpointSource(config);
        if (blockIndex !== null && blockIndex !== undefined) {
            let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                                contract_hash, checkpoint_seq, snapshot_block,
                                state_root, state_root_version, block_merkle_root, block_merkle_version,
                                validator_signatures, created_at
                         FROM ${src.table}
                         WHERE block_index = ?${src.filter}
                         ORDER BY checkpoint_seq DESC LIMIT 1`;
            return this.normalizeCheckpointRows(await this.doQuery(config, query, [Number(blockIndex), ...src.filterParams]));
        }
        // Shares the latest-per-height rule with getCheckpoints rather than carrying a
        // second list query with its own bounding. This branch backs the public
        // /api/checkpoints route, so an unbounded whole-table GROUP BY here reaches
        // further than the same mistake would in the internal feed.
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this.latestCheckpointPredicate(src, 'sc');
        let query = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                            sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                            sc.state_root, sc.state_root_version, sc.block_merkle_root, sc.block_merkle_version,
                            sc.validator_signatures, sc.created_at
                     FROM ${src.table} sc
                     WHERE 1=1${scFilter}${latest.sql}
                     ORDER BY sc.block_index DESC
                     LIMIT ?`;
        return this.normalizeCheckpointRows(await this.doQuery(config, query, [...src.filterParams, ...latest.params, Number(limit) || 10]));
    }

    // Detail-page load for ONE checkpointed height (highest checkpoint_seq wins,
    // mirroring getCheckpointRows' blockIndex branch). Deliberately does NO signature
    // verification: that is processCheckpointVerifyRequest's job (getCheckpointRows +
    // the quorum predicates), a separate and more expensive path. This is the cheap
    // read the detail page renders around, so it stays a plain keyed SELECT.
    // config.data.search carries the requested height. Returned wrapped in a
    // single-element array (null when not found), matching getBlock's convention for
    // a getData-dispatched detail getter.
    async getCheckpoint(config){
        let src   = this.checkpointSource(config);
        let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                            contract_hash, checkpoint_seq, snapshot_block,
                            state_root, state_root_version, block_merkle_root, block_merkle_version,
                            validator_signatures, created_at
                     FROM ${src.table}
                     WHERE block_index = ?${src.filter}
                     ORDER BY checkpoint_seq DESC LIMIT 1`;
        let rows = this.normalizeCheckpointRows(
            await this.doQuery(config, query, [Number(config.data.search), ...src.filterParams]));
        return [(rows && rows.length) ? rows[0] : null];
    }

    // List quorum-signed checkpoints (DataTables paging leg, spec explorer-coverage-
    // completion M2.1). Keeps getCheckpointRows' "latest checkpoint_seq per
    // block_index" semantics (a reorged height is superseded by a fresh row at the
    // same block_index, so MAX(checkpoint_seq) resolves the current one), but
    // getCheckpointRows' own list branch GROUP BYs the WHOLE mirrored history to
    // compute that per-height max, which cannot back a paged list view (a full-table
    // aggregate on every page). Bound the raw rows fed into the GROUP BY instead: a
    // duplicate checkpoint_seq for one height only arises from a rare split-brain
    // resubmission, so a window many pages deep still resolves effectively every
    // reachable height to one row, while the aggregate itself stops being a
    // full-table scan. total/paging both report against that same bounded window
    // rather than the unbounded eternity, so the two numbers stay consistent with
    // what is actually reachable by paging.
    // "The latest checkpoint_seq at this height" as a correlated point lookup.
    // Both checkpoint list queries need it and they must agree, so it is built
    // once here rather than written twice with different bounding rules.
    //
    // This replaced a derived table that pre-selected a fixed window of raw rows
    // and GROUPed it. That shape was wrong in two different ways: the window was
    // pinned to the tip while the paging cursor was applied OUTSIDE it, so on a
    // chain with more raw rows than the window, deep pages joined against a set
    // that could not contain them and came back empty with a capped total; and
    // the sibling query in getCheckpointRows had no window at all and grouped the
    // whole table. The correlated form rides the (chain, checkpoint_seq) unique
    // key one row at a time, so it needs no window, cannot truncate a page, and
    // leaves the cursor in the outer WHERE where getData's arg assembly expects
    // it (baseArgs first, offsetArgs appended last).
    latestCheckpointPredicate(src, alias){
        let innerFilter = src.filter.replace(/\b(chain|network)\b/g, 's.$1');
        return {
            sql: ` AND ${alias}.checkpoint_seq = (SELECT MAX(s.checkpoint_seq)
                       FROM ${src.table} s
                       WHERE s.block_index = ${alias}.block_index${innerFilter})`,
            params: [...src.filterParams]
        };
    }

    async getCheckpoints(config){
        let sql   = config.data.sql;
        let src   = this.checkpointSource(config);
        // Requalify the bare chain/network filter to the `m` alias: the latest-per-
        // height predicate alone is not enough to scope by coin, since checkpoint_seq
        // is only unique WITHIN one (chain, network) pair (uq_chain_seq), not globally.
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let latest      = this.latestCheckpointPredicate(src, 'm');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + outerFilter + latest.sql;
        let query = `SELECT
                        m.block_index,
                        m.created_at,
                        m.checkpoint_seq,
                        m.snapshot_block,
                        m.state_root,
                        m.block_merkle_root,
                        JSON_LENGTH(m.validator_signatures) AS signer_count
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + outerFilter + latest.sql + sql.where.offset + `
                    ORDER BY m.block_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Placeholders in left-to-right text order: the outer chain/network filter,
        // then the same pair inside the correlated subquery. getData() appends the
        // cursor args after these, and the count query reuses the SAME array because
        // it carries the identical two occurrences and no cursor.
        let args = [...src.filterParams, ...latest.params];
        return [query, args, count];
    }

    // List quorum-attested ANCHOR publisher-reward rows (hub-mirrored
    // anchor_reward_attestations, one of HUB_STATE_TABLES in hub_db_sync.js, mirrored on
    // the SAME terms as state_checkpoints: id-parity INSERT IGNORE, never retracted). Read
    // from the same co-located checkpoint schema as getCheckpoints via
    // checkpointSource().rewardTable, NEVER through HubOperationalCache and never over a
    // hub RPC: this is locally-mirrored transport, not an RPC-served cache with a TTL and
    // a row cap. Unlike capability_snapshots (chain-agnostic), this table carries its own
    // chain/network columns and its unique key is scoped by them, so src.filter/
    // src.filterParams ARE bound here, first, exactly as getCheckpoints binds them.
    //
    // Placement note: the filter text leads and the optional TYPE clause follows, which is
    // the reverse of getCheckpoints' literal order. getCheckpoints has no TYPE filter at
    // all, so nothing there could land a client placeholder ahead of the filter's;
    // here one could, which would break the args order.
    //
    // reward_amount (audit-only: the indexer credits a frozen protocol constant, never
    // this wire value) and publisher_attestations (the raw quorum-signature JSON blob) are
    // deliberately excluded from the list SELECT. type in {anchor, block, pubkey}.
    async getAnchorRewardAttestations(config){
        let sql   = config.data.sql;
        let src   = this.checkpointSource(config);
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.rewardTable} m
                    WHERE 1=1` + outerFilter + ` AND ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.chain,
                        m.network,
                        m.reward_type,
                        m.round_reference,
                        m.snapshot_block,
                        m.publisher,
                        m.reward_amount,
                        m.doge_anchor_txid,
                        m.created_at
                    FROM
                        ${src.rewardTable} m
                    WHERE 1=1` + outerFilter + ` AND ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        // filterParams (chain, network) come first, matching this table's own unique-key
        // scoping; the type-bound placeholder getQueryWhereSql appends to sql.where.data
        // follows, and only when a TYPE is actually set.
        let typeArgs = ['anchor','block','pubkey'].includes(config.data.type) ? [config.data.search] : [];
        let args = [...src.filterParams, ...typeArgs];
        return [query, args, count];
    }

    // ── SPV light-client proof serving (Phase 3, spec §8.1) ──────────────────
    // All read-only. The signed checkpoint (with the committed state_root) is read
    // from the co-located hub DB; the SMT node store + per-block sub-roots + the
    // authoritative balance derivation are read from the indexer DB (the default
    // per-coin pool). state_tree_nodes is NOT replicated by xchain-sync, so a proof
    // server MUST point at a full indexer DB (a thin replica cannot serve proofs).

    // The signed checkpoint at the nearest checkpointed height >= `height` (or the
    // latest when height is null), resolving MAX(checkpoint_seq) per height. Carries
    // the Phase 2 committed roots so a client can bind a proof to the signed state_root.
    // With a height: the nearest signed checkpoint at or above it (ASC). With a null
    // height (a "latest" balance-proof query): the freshest signed checkpoint (DESC),
    // not the oldest, so a no-height query binds to current state rather than genesis.
    async getCheckpointAtOrAbove(config, height) {
        let src = this.checkpointSource(config);
        let scFilter   = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let heightInner = (height != null) ? ' AND block_index >= ?' : '';
        let order       = (height != null) ? 'ASC' : 'DESC';
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter}${heightInner} GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ${order} LIMIT 1`;
        let params = (height != null)
            ? [...src.filterParams, Number(height), ...src.filterParams]
            : [...src.filterParams, ...src.filterParams];
        let rows = await this.doQuery(config, q, params);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Ordered signed checkpoints in [from, to] (forward-following, spec §8.1).
    async getCheckpointRange(config, fromH, toH, limit) {
        let src = this.checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures, sc.created_at
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter} AND block_index BETWEEN ? AND ? GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ASC LIMIT ?`;
        let params = [...src.filterParams, Number(fromH), Number(toH), ...src.filterParams, Number(limit) || 100];
        return await this.doQuery(config, q, params) || [];
    }

    // The signed checkpoint AT EXACTLY this height (MAX(checkpoint_seq)). An action
    // proof binds to the checkpoint that commits THIS block's block_merkle_root, which
    // is per-block, so unlike a balance proof (nearest at-or-above) it needs the exact
    // height. Null if that block was never checkpointed (D3: checkpointed heights only).
    async getCheckpointAt(config, blockIndex) {
        let src = this.checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter} AND block_index=? GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ASC LIMIT 1`;
        let params = [...src.filterParams, Number(blockIndex), ...src.filterParams];
        let rows = await this.doQuery(config, q, params);
        return (rows && rows.length) ? rows[0] : null;
    }
}

module.exports = CheckpointRowReaders.prototype;
