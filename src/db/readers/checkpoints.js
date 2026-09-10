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
 * XChain Explorer - checkpoint, state-tree and since-cursor readers
 *
 * Proposal B stage 4: the
 * hub-mirrored checkpoint tables and their source selection, the state-tree
 * and net-balance readers that hang off them, capability snapshots, and the
 * two since-cursor feeds (getBlocksSince, getActionsSince) that the WebSocket
 * ChangeDetector polls.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 * The move is verbatim: no module-level binding from db.js is referenced from
 * any method below, which is what made this family safe to lift whole.
 *
 ********************************************************************/

'use strict';

class CheckpointReaders {
    // Resolve the checkpoint-table source for a coin. These hub-mirrored tables
    // (state_checkpoints, capability_snapshots) are pushed/retracted by the hub
    // out-of-band with block apply, so xchain-sync EXCLUDES them from every
    // snapshot and stream. A serving node therefore MUST read them from the
    // same-server `checkpoint` schema (config database.checkpoint,
    // database-qualified + chain/network-filtered; the hub table carries every
    // chain): either an externally-maintained hub schema or a self-synced mirror
    // kept live by HubMirrorSyncManager over the hub's /hub-db feed. There is
    // deliberately NO fallback to the replicated indexer DB: a thin replica has
    // only a stale/empty bootstrap copy of these tables, and silently serving
    // that would publish wrong consensus-relevant data with no alarm (#4138; a
    // never-bootstrapped self-sync mirror is likewise gated by the mirror-status
    // check in the routes). When the checkpoint schema is absent or its
    // configured name is not a safe identifier we FAIL LOUD by throwing,
    // surfacing the misconfiguration to the route (HTTP 500 + log) instead of
    // serving stale rows. dbName is config-derived, not client input, but
    // database identifiers can't be bound; restrict to a safe identifier charset
    // before use (same rule as the decoderDb readers above).
    _checkpointSource(config){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name))
            return { table: '`' + src.name + '`.state_checkpoints',
                     capTable: '`' + src.name + '`.capability_snapshots',
                     // Quorum-attested ANCHOR publisher rewards (HUB_STATE_TABLES in
                     // hub_db_sync.js, mirrored on the same terms as state_checkpoints).
                     // Neither `table` nor `capTable`, so it gets a third accessor on the
                     // same helper rather than a hand-built schema-qualified name, keeping
                     // ONE place that knows the mirror's shape.
                     rewardTable: '`' + src.name + '`.anchor_reward_attestations',
                     // `filter`/`filterParams` scope `table` and `rewardTable`, which both
                     // carry chain/network columns. They do NOT apply to `capTable`:
                     // capability_snapshots is chain-agnostic (keyed by capability + BTC
                     // snapshot block) and has no such columns - see getCapabilitySnapshots
                     // and getCapabilitySnapshotRows, which bind none of these.
                     filter: ' AND chain = ? AND network = ?',
                     filterParams: [src.chain, src.network] };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': state_checkpoints / capability_snapshots / anchor_reward_attestations are served only from the mandatory ' +
            'co-located hub DB (config database.checkpoint, same host+credentials as the indexer DB), ' +
            'never from a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Resolve the cross_chain_matches source for a coin, mirroring _checkpointSource:
    // same hub-mirror-only rule, same FAIL LOUD posture, same identifier-safety
    // restriction. The hub table carries every chain AND network here, so a network
    // filter is required (unlike the state_checkpoints table above). Self-sync note:
    // batch_root/anchor_txid are backfilled hub-side by UPDATE after anchor
    // publication and the feed has no update event, so on a self-synced mirror those
    // two audit columns can read NULL; all settlement-relevant columns arrive on the
    // insert.
    _matchSource(config){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name))
            return { table: '`' + src.name + '`.cross_chain_matches',
                     networkFilter: ' AND m.network = ?',
                     networkParam: src.network };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': cross_chain_matches is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB), never from ' +
            'a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Resolve an ORACLE hub-mirror table for a coin (price_snapshots, oracle_prices),
    // mirroring _matchSource: same hub-mirror-only, FAIL LOUD rule. A serving node's
    // local copy is an empty bootstrap table the live stream never fills. Neither
    // table carries a network column, so there is no network filter to apply (unlike
    // cross_chain_matches); `table` is whitelisted to lowercase identifiers and
    // dbName to a safe identifier charset, since database identifiers cannot be bound.
    _oracleMirrorSource(config, table){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name) && /^[a-z0-9_]+$/.test(table))
            return { table: '`' + src.name + '`.' + table };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': ' + table + ' is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB), never from ' +
            'a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Apply the generic id-keyed datatable paging semantics to RPC-sourced rows in
    // JS, mirroring what getQueryOffsetSql + ORDER BY m.id + LIMIT do in SQL for the
    // id-keyed list methods: action 'prev' keeps id > start (and < stop), 'last'
    // keeps id <= start, 'next'/default keeps id < start (and > stop). total is the
    // filtered count BEFORE the cursor window (matching the SQL count query, which
    // uses where.data but not where.offset). Rows arrive server-filtered and capped
    // hub-side (500), so totals saturate there; these are small operational datasets.
    _pageHubOperationalRows(config, rows){
        let filtered = rows.slice();
        let total    = filtered.length;
        let offset = config.data.offset || {};
        let action = !this.util.isNull(offset.action) ? offset.action : false;
        let start  = (!this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? Number(offset.start) : false;
        let stop   = (!this.util.isNull(offset.stop)  && this.util.isNumeric(offset.stop))  ? Number(offset.stop)  : false;
        if(action && start !== false){
            if(action=='prev')
                filtered = filtered.filter(r => Number(r.id) > start && (stop === false || Number(r.id) < stop));
            else if(action=='last')
                filtered = filtered.filter(r => Number(r.id) <= start);
            else
                filtered = filtered.filter(r => Number(r.id) < start && (stop === false || Number(r.id) > stop));
        }
        let order = (config.data.sql && config.data.sql.order === 'ASC') ? 'ASC' : 'DESC';
        filtered.sort((a, b) => order === 'ASC' ? Number(a.id) - Number(b.id) : Number(b.id) - Number(a.id));
        let limit = (config.data.sql && this.util.isNumeric(config.data.sql.limit)) ? Number(config.data.sql.limit) : 100;
        let from  = (config.type == 'api' && config.data.sql && Number(config.data.sql.apiOffset) > 0)
            ? Number(config.data.sql.apiOffset) : 0;
        return [this._normalizeHubOperationalRows(filtered.slice(from, from + limit)), null, total];
    }

    // One wire type for the BIGINT columns these three endpoints serve, on both
    // transports. The hub RPC path carries them as JS Numbers (the hub's pool sets
    // bigIntAsNumber, xchain-hub/src/db.js), while the legacy co-located-schema read
    // returns BigInt that the response sink stringifies (utility.jsonStringify), so
    // an unnormalized pass-through flips `id` between 100 and "100" whenever the hub
    // goes unreachable mid-deployment. Coerce to decimal STRING, matching
    // _normalizeCheckpointRows and the platform-wide BIGINT-as-string convention.
    // Key-guarded because the three row shapes carry different subsets
    // (validator_capabilities has qualified_at_block, governance_proposals has
    // activation_block, governance_votes has neither): an absent or null column must
    // stay absent or null, never become the literal string "undefined".
    _normalizeHubOperationalRows(rows){
        const bigintKeys = ['id', 'qualified_at_block', 'activation_block',
                            'reorg_height', 'reorg_timestamp', 'round_number'];
        return (rows || []).map(r => {
            let out = { ...r };
            for(const k of bigintKeys)
                if(out[k] !== undefined && out[k] !== null) out[k] = String(out[k]);
            return out;
        });
    }

    // Resolve a co-located hub-DB federation/governance table for a coin
    // (validator_capabilities, governance_proposals, governance_votes). Mirrors
    // _matchSource: DB-qualified to the co-located hub DB, read directly, never a
    // local replica. `table` is whitelisted to lowercase identifiers (no injection).
    // Federation data is platform-global (no per-chain network column), so there is
    // no network filter.
    //
    // NO-HUB DEPLOYMENT SHAPE ONLY: the primary transport for these hub-LOCAL
    // operational tables is the hub JSON-RPC read path (explorer.hubOperational,
    // HubOperationalCache); this direct-schema read serves only deployments with NO
    // hub endpoint configured at all (hubOperational.enabled() false). It is NOT a
    // fallback for a configured-but-unreachable hub: that case fails loud through
    // _hubOperationalOutage below, because this table carries no freshness bound and
    // would otherwise serve indefinitely stale operational rows. New deployments
    // should set HUB_API_URL instead of provisioning a co-located hub schema.
    _hubSource(config, table){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name) && /^[a-z0-9_]+$/.test(table))
            return { table: '`' + src.name + '`.' + table };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': ' + table + ' is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB). ' +
            'Configure the checkpoint DB block to serve this coin.');
    }

    // FAIL LOUD when a CONFIGURED hub is unreachable past HubOperationalCache's stale
    // ceiling (EXPLORER_HUB_CACHE_STALE_MAX_MS, default 600s). Once a hub endpoint is
    // configured, validator_capabilities/governance_proposals/governance_votes are
    // served from the hub or not at all: the co-located schema carries no freshness
    // bound (governance_proposals has no freshness column at all), so falling back to
    // it would serve indefinitely stale operational state that looks live. The
    // accepted cost is that these three pages blank on a co-located install whose hub
    // PROCESS is down while its hub DB is still up; a blank page with a reason beats a
    // stale page without one.
    _hubOperationalOutage(table){
        let ops     = this.explorer ? this.explorer.hubOperational : null;
        let ceiling = (ops && this.util.isNumeric(ops.staleMaxMs)) ? Math.round(ops.staleMaxMs / 1000) : 600;
        throw new Error('Hub unreachable: ' + table + ' could not be read over hub JSON-RPC and the ' +
            'last cached rows are older than the ' + ceiling + 's stale ceiling ' +
            '(EXPLORER_HUB_CACHE_STALE_MAX_MS). With a hub endpoint configured this table is served ' +
            'from the hub only, never from the co-located hub schema, which carries no freshness ' +
            'bound. Restore the hub endpoint, or unset HUB_API_URL and hub discovery to run this ' +
            'install on the co-located schema.');
    }

    // BIGINT columns (block_index/checkpoint_seq/snapshot_block) come back from
    // the mariadb driver as BigInt, which res.json() cannot serialize. Coerce to
    // STRING, not Number: every other serialized index on this server's REST and
    // WS surface is a decimal string (utility.jsonStringify and ws/serialize.js
    // both stringify BigInt), so a numeric checkpoint block_index would be the one
    // endpoint where `100 !== "100"` against a WS NEW_BLOCK index. String also
    // keeps the wire type precision-safe past 2^53. Consensus-safe: the canonical
    // signing string String()s these fields (canonicalCheckpointString) and the
    // flag-day gates parseInt them, so the verified bytes are unchanged.
    _normalizeCheckpointRows(rows){
        return (rows || []).map(r => ({
            ...r,
            block_index:    String(r.block_index),
            checkpoint_seq: String(r.checkpoint_seq),
            snapshot_block: String(r.snapshot_block),
            // One wire type across the checkpoint REST family: a parsed array,
            // matching proofServer._shapeCheckpoint. The DB column is a JSON
            // string; leaving it raw here made /checkpoints and /verify emit a
            // STRING while /checkpoints/range emitted an ARRAY for the same
            // logical field (api-contracts drift). Malformed JSON degrades to
            // [] like the SDK's own defensive coercion.
            validator_signatures: this._parseSignaturesArray(r.validator_signatures)
        }));
    }

    _parseSignaturesArray(v){
        if (Array.isArray(v)) return v;
        if (typeof v !== 'string' || !v.length) return [];
        try {
            let parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }

    // Quorum-signed state checkpoints (hub-mirrored state_checkpoints table).
    // blockIndex null → latest N (one per height: MAX(checkpoint_seq) wins);
    // blockIndex set → that height's latest-seq row only.
    async getCheckpointRows(config, blockIndex, limit) {
        let src = this._checkpointSource(config);
        if (blockIndex !== null && blockIndex !== undefined) {
            let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                                contract_hash, checkpoint_seq, snapshot_block,
                                state_root, state_root_version, block_merkle_root, block_merkle_version,
                                validator_signatures, created_at
                         FROM ${src.table}
                         WHERE block_index = ?${src.filter}
                         ORDER BY checkpoint_seq DESC LIMIT 1`;
            return this._normalizeCheckpointRows(await this.doQuery(config, query, [Number(blockIndex), ...src.filterParams]));
        }
        // Shares the latest-per-height rule with getCheckpoints rather than carrying a
        // second list query with its own bounding. This branch backs the public
        // /api/checkpoints route, so an unbounded whole-table GROUP BY here reaches
        // further than the same mistake would in the internal feed.
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this._latestCheckpointPredicate(src, 'sc');
        let query = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                            sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                            sc.state_root, sc.state_root_version, sc.block_merkle_root, sc.block_merkle_version,
                            sc.validator_signatures, sc.created_at
                     FROM ${src.table} sc
                     WHERE 1=1${scFilter}${latest.sql}
                     ORDER BY sc.block_index DESC
                     LIMIT ?`;
        return this._normalizeCheckpointRows(await this.doQuery(config, query, [...src.filterParams, ...latest.params, Number(limit) || 10]));
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
        let src   = this._checkpointSource(config);
        let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                            contract_hash, checkpoint_seq, snapshot_block,
                            state_root, state_root_version, block_merkle_root, block_merkle_version,
                            validator_signatures, created_at
                     FROM ${src.table}
                     WHERE block_index = ?${src.filter}
                     ORDER BY checkpoint_seq DESC LIMIT 1`;
        let rows = this._normalizeCheckpointRows(
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
    _latestCheckpointPredicate(src, alias){
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
        let src   = this._checkpointSource(config);
        // Requalify the bare chain/network filter to the `m` alias: the latest-per-
        // height predicate alone is not enough to scope by coin, since checkpoint_seq
        // is only unique WITHIN one (chain, network) pair (uq_chain_seq), not globally.
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let latest      = this._latestCheckpointPredicate(src, 'm');
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
    // _checkpointSource().rewardTable, NEVER through HubOperationalCache and never over a
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
        let src   = this._checkpointSource(config);
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
        let src = this._checkpointSource(config);
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
        let src = this._checkpointSource(config);
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

    // Per-block sub-roots from the indexer DB (state_tree_nodes' companion roots).
    async getStateTreeRow(config, blockIndex) {
        // contract_state_root is the reserved-slot extension column (SPV sub-tree
        // spec Stage A). NULL means the slot committed EMPTY at this height, which
        // is every historical row and every row on a chain that has not armed it.
        // It MUST be selected here: the sub-root set this row reassembles to is
        // what binds a served proof to the signed checkpoint, and omitting a
        // populated column reassembles to the wrong state_root and refuses to
        // serve every proof at that height.
        let rows = await this.doQuery(config,
            `SELECT balances_root, stakes_root, state_root, block_merkle_root, contract_state_root
             FROM state_tree_roots WHERE block_index = ? LIMIT 1`, [Number(blockIndex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Raw stored state_value for one contract state key AS-OF a height, or null
    // when the key has no row at or below it OR its winning row is a deletion
    // tombstone. This is the leaf preimage for a contract-state proof, so it must
    // mirror the commitment's mapping exactly (contractStateSubtree.js):
    //
    //   - state_key_bin, the utf8_bin shadow, NEVER state_key. contract_state is
    //     utf8_general_ci, so matching on state_key can return a row for a
    //     DIFFERENT key that merely case-folds to the requested one, and the proof
    //     would be cryptographically valid while binding the wrong key.
    //   - highest id at or below the height, tombstones INCLUDED in the ordering
    //     and tested afterwards. Filtering NULLs first would return the last
    //     surviving write of a deleted key, contradicting the commitment, which
    //     has no leaf for it.
    //   - the RAW stored string, never JSON.parse'd: the client hashes these bytes.
    async getContractStateValueAtHeight(config, contractIndex, stateKey, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT state_value FROM contract_state
             WHERE contract_index = ? AND state_key_bin = ? AND block_index <= ?
             ORDER BY id DESC LIMIT 1`,
            [Number(contractIndex), String(stateKey), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].state_value == null) ? null : String(rows[0].state_value);
    }

    // Locked-balance (XCHAIN_ESC) leaf preimage as-of a height: the latest
    // escrow_leaf_journal row at or below it. The journal is append-only with a
    // block_index (the indexer's writer appends one row per key per block whose
    // total changed), so this read is exact, exactly like contract_state above.
    // MAX(id) runs over ALL rows including NULL tombstones: filtering them
    // before the max would resurrect a released lock at its last positive value.
    // NULL (tombstone) and no-row both return null, which the proof layer maps
    // to "zero locked", matching the reader's delete-on-zero rule.
    async getLockedAmountAtHeight(config, address, tick, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT j.locked_amount FROM escrow_leaf_journal j
             INNER JOIN index_addresses a ON a.id = j.address_id
             INNER JOIN index_tickers   t ON t.id = j.tick_id
             WHERE a.address = ? AND t.tick = ? AND j.block_index <= ?
             ORDER BY j.id DESC LIMIT 1`,
            [String(address), String(tick), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].locked_amount == null) ? null : String(rows[0].locked_amount);
    }

    // One internal SMT node (content-addressed) from the indexer node store.
    async getStateNode(config, nodeHashHex) {
        let rows = await this.doQuery(config,
            'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash = ? LIMIT 1',
            [String(nodeHashHex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Authoritative net-spendable balance (SUM credits - SUM debits) at 18 dp,
    // resolved by canonical strings (never the mutable balances cache), matching
    // the indexer's stateCommitment.getNetBalance leaf source.
    async getNetBalance18(config, address, tick) {
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a ON a.id=c.address_id
                    INNER JOIN index_tickers   t ON t.id=c.tick_id
                    WHERE a.address=? AND t.tick=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a ON a.id=d.address_id
                    INNER JOIN index_tickers   t ON t.id=d.tick_id
                    WHERE a.address=? AND t.tick=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, address, tick]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // Height-bounded net-spendable balance: the SAME query shape/arithmetic as
    // getNetBalance18 (DECIMAL(60,18) SUM(credits)-SUM(debits), returned as a
    // canonical string), but each side is bounded to actions committed at or
    // before blockIndex. credits/debits carry no block_index of their own, so we
    // bind height through actions.action_index (the canonical "at height" join,
    // same as stateHash.js's tick-touch query), matching the state at the moment
    // the indexer computed the checkpoint-height balances leaf. A balance proof
    // must serve the amount committed at cp.block_index, NOT the current tip, or
    // the SDK's amountLeaf(amount) check false-rejects with LEAF_AMOUNT_MISMATCH.
    async getNetBalance18AtHeight(config, address, tick, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a  ON a.id=c.address_id
                    INNER JOIN index_tickers   t  ON t.id=c.tick_id
                    INNER JOIN actions         ac ON ac.action_index=c.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a  ON a.id=d.address_id
                    INNER JOIN index_tickers   t  ON t.id=d.tick_id
                    INNER JOIN actions         ac ON ac.action_index=d.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, Number(blockIndex), address, tick, Number(blockIndex)]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // The action's own block_index (its consensus block, a.block_index), which
    // resolves the block whose block_merkle_root an action proof binds to. Null if the
    // action does not exist on this server.
    async getActionBlockIndex(config, actionIndex) {
        let rows = await this.doQuery(config,
            'SELECT block_index FROM actions WHERE action_index=? LIMIT 1', [Number(actionIndex)]);
        return (rows && rows.length && rows[0].block_index != null) ? Number(rows[0].block_index) : null;
    }

    // The signed checkpoint AT EXACTLY this height (MAX(checkpoint_seq)). An action
    // proof binds to the checkpoint that commits THIS block's block_merkle_root, which
    // is per-block, so unlike a balance proof (nearest at-or-above) it needs the exact
    // height. Null if that block was never checkpointed (D3: checkpointed heights only).
    async getCheckpointAt(config, blockIndex) {
        let src = this._checkpointSource(config);
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

    // The canonical per-block leaf rows (ledger/actions/contracts) in the EXACT order
    // + binary collations the indexer's getBlockHashes hashes them (SPV spec §5.1).
    // A verbatim port of the indexer gather (db.js getBlockHashes): every query scopes
    // by the ACTION's own block_index (a.block_index, covering tx_index-NULL synthetic
    // actions), resolves canonical strings (never local AUTO_INCREMENT ids), and pins
    // BINARY collations on the tie-order keys so the order is collation-independent.
    // Returns the shape merkle.blockMerkleLeaves consumes; a single byte of drift from
    // the indexer gather silently invalidates every produced action proof.
    async getBlockLeafRows(config, block_index) {
        const bi = Number(block_index);
        const ledger = { credits: [], debits: [], escrows: [] };
        ledger.credits = await this.doQuery(config,
            `SELECT c.action_index, a1.address AS address, t1.tick AS tick, c.amount
             FROM credits c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=c.tick_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, c.amount ASC`, [bi]);
        ledger.debits = await this.doQuery(config,
            `SELECT d.action_index, a1.address AS address, t1.tick AS tick, d.amount
             FROM debits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC`, [bi]);
        ledger.escrows = await this.doQuery(config,
            `SELECT e.action_index, a1.address AS address, t1.tick AS tick, e.amount
             FROM escrows e
                INNER JOIN actions a ON (a.action_index=e.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=e.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=e.tick_id)
             WHERE a.block_index=?
             ORDER BY e.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, e.amount ASC`, [bi]);
        const actions = await this.doQuery(config,
            `SELECT a.action_index, a.tx_index, ia.action AS action
             FROM actions a
                LEFT JOIN index_actions ia ON (ia.id=a.action_id)
             WHERE a.block_index=?
             ORDER BY a.action_index ASC`, [bi]);
        const contracts = { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] };
        contracts.contracts = await this.doQuery(config,
            `SELECT c.action_index, a1.address AS source_address, c.code_hash, s1.status AS status
             FROM contracts c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=c.status_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC`, [bi]);
        contracts.state = await this.doQuery(config,
            `SELECT cs.contract_index, cs.state_key, cs.state_value
             FROM contract_state cs
                INNER JOIN (SELECT MAX(id) as max_id FROM contract_state
                            WHERE block_index=? GROUP BY contract_index, state_key) latest
                   ON cs.id = latest.max_id
             ORDER BY cs.contract_index ASC, cs.state_key ASC`, [bi]);
        contracts.executions = await this.doQuery(config,
            `SELECT ce.action_index, ce.contract_index, a1.address AS caller_address, ce.gas_used, s1.status AS status, ce.emitted_count
             FROM contract_executions ce
                INNER JOIN actions a ON (a.action_index=ce.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=ce.caller_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=ce.status_id)
             WHERE a.block_index=?
             ORDER BY ce.action_index ASC`, [bi]);
        contracts.emissions = await this.doQuery(config,
            `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
             FROM contract_emissions em
                INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                INNER JOIN actions a ON (a.action_index=ce.action_index)
             WHERE a.block_index=?
             ORDER BY em.execution_index ASC, em.position ASC`, [bi]);
        contracts.deposits = await this.doQuery(config,
            `SELECT d.action_index, d.contract_index, a1.address AS source_address, t1.tick AS tick, d.amount, s1.status AS status
             FROM deposits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=d.status_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, d.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
        contracts.withdrawals = await this.doQuery(config,
            `SELECT w.action_index, w.contract_index, a1.address AS source_address, t1.tick AS tick, w.amount, s1.status AS status
             FROM withdrawals w
                INNER JOIN actions a ON (a.action_index=w.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=w.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=w.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=w.status_id)
             WHERE a.block_index=?
             ORDER BY w.action_index ASC, w.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, w.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
        return { block_index: bi, ledger, actions, contracts };
    }

    // Hub-mirrored qualifying validator set for a capability at a snapshot block;
    // what checkpoint signatures verify against (presence = qualified).
    // capability_snapshots is chain-agnostic (keyed by capability + BTC snapshot
    // block), so the configured checkpoint DB needs no chain/network filter here.
    async getCapabilitySnapshotRows(config, capability, snapshotBlock) {
        let src = this._checkpointSource(config);
        // `source` carries the stake-weight grouping key (the staking source a
        // signing key delegates from); `amount` is that key's stake weight. Both
        // are needed for stake-weighted quorum at/above the activation flag-day;
        // below it `source` is the empty string and only the count matters.
        let query = `SELECT signing_pubkey, amount, source FROM ${src.capTable}
                     WHERE capability = ? AND snapshot_block = ?`;
        return await this.doQuery(config, query, [String(capability), Number(snapshotBlock)]);
    }

    // The same historical electorate as a routed, paged LIST view: which signing keys
    // carried which stake weight for a capability at a snapshot block. Sibling of
    // getCapabilitySnapshotRows above (positional, two mandatory binds, no paging, used
    // by the checkpoint-verify path) rather than a shared predicate: the two have
    // different bind arity and column sets, and a bare list-all with no filter is a normal
    // request here, which the raw reader's two-mandatory-arg contract must never acquire.
    // Same getCheckpoints/getCheckpoint precedent.
    //
    // Never routed through HubOperationalCache and never an RPC call: capability_snapshots
    // is not hub-RPC data, it is pushed into the co-located checkpoint-mirror schema
    // out-of-band, so this list must answer with the hub completely unreachable. id-keyed
    // (the paging cursor); capability_snapshots is chain-agnostic (no chain/network
    // columns), so unlike getCheckpoints there is no src.filter/src.filterParams to bind.
    async getCapabilitySnapshots(config){
        let sql   = config.data.sql;
        let src   = this._checkpointSource(config);
        let count = `SELECT count(*) as total FROM ${src.capTable} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.snapshot_block,
                        m.capability,
                        m.signing_pubkey,
                        m.amount,
                        m.source,
                        m.created_at
                    FROM
                        ${src.capTable} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBlocksSince(config, sinceBlockIndex, limit) {
        let query = `SELECT
                        b1.block_index,
                        b1.block_time,
                        t1.hash as block_hash,
                        t3.hash as contract_hash,
                        t4.hash as state_hash,
                        (SELECT COUNT(*) FROM transactions t WHERE t.block_index=b1.block_index) as tx_count,
                        (SELECT COUNT(*) FROM actions a
                            INNER JOIN transactions t ON t.tx_index=a.tx_index
                            WHERE t.block_index=b1.block_index) as action_count
                    FROM
                        blocks b1
                        LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                        LEFT JOIN index_transactions t4 ON (t4.id=b1.state_hash_id)
                    WHERE
                        b1.block_index > ?
                    ORDER BY b1.block_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getActionsSince(config, sinceActionIndex, limit) {
        // Pass the cursor as a BigInt (or a Number below 2^53), NEVER a decimal
        // string: the connector quotes a string param, and MariaDB compares a
        // quoted literal against a BIGINT column as a DOUBLE, which reintroduces
        // exactly the >2^53 collapse the BigInt cursor exists to prevent.
        // The generic `actions` table carries no status_id or status column (status
        // lives on the per-ACTION-type tables, e.g. issues/sends/mints, joined as
        // m.status_id elsewhere), so this feed reports status as NULL; a prior
        // `s1.id=a1.status_id` join against that non-existent column threw
        // ER_BAD_FIELD_ERROR and silently killed the WebSocket NEW_ACTION stream, since
        // getActionsSince returned [] every poll while the pointer kept advancing.
        // Source is taken from actions.source_id (a1): the action's true source,
        // which for VM-emitted actions differs from the EXECUTE caller on transactions.
        // action_format rides along because one action NAME can carry several
        // formats whose live meanings are unrelated: a BET v2 is a stake placed and
        // a BET v3 is the payout decision. Without it a subscriber is told only
        // "a BET happened" and has to re-fetch to learn which, which defeats the
        // point of a push channel (ChangeDetector routes BET on it, §11.1).
        // `transactions` is a LEFT join, never an INNER one: a system-synthesized
        // action carries a real action_index and block_index but a NULL tx_index and
        // has no transactions row at all, so an INNER join drops it from this feed
        // ENTIRELY. That is not just a missing NEW_ACTION frame: ChangeDetector calls
        // _emitAttestationEvents only for actions this query returns, so a
        // mirror-applied ATTEST v1 response (attest-response-mirror spec §4.4) would
        // never fire ATTESTATION_RESPONSE on any subscriber. The block comes off the
        // action's own a1.block_index, so nothing here needs the transaction row;
        // tx_hash is simply NULL for a synthesized action, which is the honest answer.
        let query = `SELECT
                        a1.action_index,
                        a3.action,
                        a1.action_format,
                        t3.hash as tx_hash,
                        a1.block_index,
                        a4.address as source,
                        NULL as status
                    FROM
                        actions a1
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=a1.source_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE
                        a1.action_index > ?
                    ORDER BY a1.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceActionIndex, limit]);
        if(!results || !results.length) return [];
        // Destinations are attached in a SECOND pass rather than joined into the
        // query above, because eight LEFT JOINs would multiply the feed's rows (a
        // multi-output SEND would emit one NEW_ACTION per output) and the feed's
        // LIMIT is a limit on ACTIONS, not on output rows. See
        // _attachActionDestinations for the batch shape and its failure mode.
        // `transactions` is a LEFT join, never an INNER one: a system-synthesized
        // action carries a real action_index and block_index but a NULL tx_index and
        // has no transactions row at all, so an INNER join drops it from this feed
        // ENTIRELY. That is not just a missing NEW_ACTION frame: ChangeDetector calls
        // _emitAttestationEvents only for actions this query returns, so a
        // mirror-applied ATTEST v1 response (attest-response-mirror spec §4.4) would
        // never fire ATTESTATION_RESPONSE on any subscriber. The block comes off the
        // action's own a1.block_index, so nothing here needs the transaction row;
        // tx_hash is simply NULL for a synthesized action, which is the honest answer.
        await this._attachActionDestinations(config, results);
        return results;
    }
}

module.exports = CheckpointReaders.prototype;
