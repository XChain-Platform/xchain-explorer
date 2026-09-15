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
 * XChain Explorer - hub-mirror source selection and row normalizers
 *
 * One part of src/db/readers/checkpoints.js (the entry composes it through
 * composeReaderParts). Which co-located hub schema a coin reads its mirrored
 * tables from, the fail-loud refusals when there is none (or when a configured
 * hub is unreachable), and the BIGINT and signature-array normalizers every
 * checkpoint read shares.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

class CheckpointSourceReaders {
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
    checkpointSource(config){
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

    // Resolve the cross_chain_matches source for a coin, mirroring checkpointSource:
    // same hub-mirror-only rule, same FAIL LOUD posture, same identifier-safety
    // restriction. The hub table carries every chain AND network here, so a network
    // filter is required (unlike the state_checkpoints table above). Self-sync note:
    // batch_root/anchor_txid are backfilled hub-side by UPDATE after anchor
    // publication and the feed has no update event, so on a self-synced mirror those
    // two audit columns can read NULL; all settlement-relevant columns arrive on the
    // insert.
    matchSource(config){
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
    // mirroring matchSource: same hub-mirror-only, FAIL LOUD rule. A serving node's
    // local copy is an empty bootstrap table the live stream never fills. Neither
    // table carries a network column, so there is no network filter to apply (unlike
    // cross_chain_matches); `table` is whitelisted to lowercase identifiers and
    // dbName to a safe identifier charset, since database identifiers cannot be bound.
    oracleMirrorSource(config, table){
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
    pageHubOperationalRows(config, rows){
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
        return [this.normalizeHubOperationalRows(filtered.slice(from, from + limit)), null, total];
    }

    // One wire type for the BIGINT columns these three endpoints serve, on both
    // transports. The hub RPC path carries them as JS Numbers (the hub's pool sets
    // bigIntAsNumber, xchain-hub/src/db/index.js), while the legacy co-located-schema read
    // returns BigInt that the response sink stringifies (utility.jsonStringify), so
    // an unnormalized pass-through flips `id` between 100 and "100" whenever the hub
    // goes unreachable mid-deployment. Coerce to decimal STRING, matching
    // normalizeCheckpointRows and the platform-wide BIGINT-as-string convention.
    // Key-guarded because the three row shapes carry different subsets
    // (validator_capabilities has qualified_at_block, governance_proposals has
    // activation_block, governance_votes has neither): an absent or null column must
    // stay absent or null, never become the literal string "undefined".
    normalizeHubOperationalRows(rows){
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
    // matchSource: DB-qualified to the co-located hub DB, which shares host and
    // credentials with the indexer DB, so the qualified name runs on the indexer
    // pool; read directly, never a local replica. `table` is whitelisted to
    // lowercase identifiers (no injection). Federation data is platform-global (no
    // per-chain network column), so there is no network filter.
    //
    // NO-HUB DEPLOYMENT SHAPE ONLY: the primary transport for these hub-LOCAL
    // operational tables is the hub JSON-RPC read path (explorer.hubOperational,
    // HubOperationalCache); this direct-schema read serves only deployments with NO
    // hub endpoint configured at all (hubOperational.enabled() false). It is NOT a
    // fallback for a configured-but-unreachable hub: that case fails loud through
    // hubOperationalOutage below, because this table carries no freshness bound and
    // would otherwise serve indefinitely stale operational rows. New deployments
    // should set HUB_API_URL instead of provisioning a co-located hub schema.
    hubSource(config, table){
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
    hubOperationalOutage(table){
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
    normalizeCheckpointRows(rows){
        return (rows || []).map(r => ({
            ...r,
            block_index:    String(r.block_index),
            checkpoint_seq: String(r.checkpoint_seq),
            snapshot_block: String(r.snapshot_block),
            // One wire type across the checkpoint REST family: a parsed array,
            // matching ProofServer.shapeCheckpoint. The DB column is a JSON
            // string; leaving it raw here made /checkpoints and /verify emit a
            // STRING while /checkpoints/range emitted an ARRAY for the same
            // logical field (api-contracts drift). Malformed JSON degrades to
            // [] like the SDK's own defensive coercion.
            validator_signatures: this.parseSignaturesArray(r.validator_signatures)
        }));
    }

    parseSignaturesArray(v){
        if (Array.isArray(v)) return v;
        if (typeof v !== 'string' || !v.length) return [];
        try {
            let parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
}

module.exports = CheckpointSourceReaders.prototype;
