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
 * XChain Explorer - capability snapshots, since-cursor feeds and hub operational pages
 *
 * One part of src/db/readers/checkpoints.js (the entry composes it through
 * composeReaderParts). The capability electorate reads, the two since-cursor
 * feeds the WebSocket ChangeDetector polls, and the hub operational-state
 * pages (reorgs, peers, consensus state, configs, telemetry).
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The first pass of getActionsSince: the action rows themselves. `db` is the Database
// instance the method runs on, passed in because this is a plain function rather than a
// method, so the cut adds no name to Database.prototype.
async function readActionsSinceRows(db, config, sinceActionIndex, limit){
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
    // emitAttestationEvents only for actions this query returns, so a
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
    let results = await db.doQuery(config, query, [sinceActionIndex, limit]);
    return results;
}

class SyncFeedReaders {
    // Hub-mirrored qualifying validator set for a capability at a snapshot block;
    // what checkpoint signatures verify against (presence = qualified).
    // capability_snapshots is chain-agnostic (keyed by capability + BTC snapshot
    // block), so the configured checkpoint DB needs no chain/network filter here.
    async getCapabilitySnapshotRows(config, capability, snapshotBlock) {
        let src = this.checkpointSource(config);
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
        let src   = this.checkpointSource(config);
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
        let results = await readActionsSinceRows(this, config, sinceActionIndex, limit);
        if(!results || !results.length) return [];
        // Destinations are attached in a SECOND pass rather than joined into the
        // query above, because eight LEFT JOINs would multiply the feed's rows (a
        // multi-output SEND would emit one NEW_ACTION per output) and the feed's
        // LIMIT is a limit on ACTIONS, not on output rows. See
        // attachActionDestinations for the batch shape and its failure mode.
        // `transactions` is a LEFT join, never an INNER one: a system-synthesized
        // action carries a real action_index and block_index but a NULL tx_index and
        // has no transactions row at all, so an INNER join drops it from this feed
        // ENTIRELY. That is not just a missing NEW_ACTION frame: ChangeDetector calls
        // emitAttestationEvents only for actions this query returns, so a
        // mirror-applied ATTEST v1 response (attest-response-mirror spec §4.4) would
        // never fire ATTESTATION_RESPONSE on any subscriber. The block comes off the
        // action's own a1.block_index, so nothing here needs the transaction row;
        // tx_hash is simply NULL for a synthesized action, which is the honest answer.
        await this.attachActionDestinations(config, results);
        return results;
    }

    // Cross-chain reorg attestations (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's EXISTING unauthenticated
    // getreorghistory RPC, so this row needs no new hub-side surface. Unlike the three
    // tables above (platform-global, no per-chain column), reorg_attestations carries
    // source_chain and getreorghistory returns EVERY chain's history with no server-side
    // chain filter at all, so a per-coin page would otherwise leak another chain's
    // reorgs. Both transports therefore scope to THIS coin's own chain: client-side
    // inside HubOperationalCache.getReorgHistory (the established pattern for a param the
    // hub RPC does not support server-side, see getGovernanceProposals' proposal_id), and
    // via an explicit m.source_chain=? on the co-located leg, matching
    // getCrossChainMatches' mandatory network filter.
    //
    // this.baseCoin[config.coin] (RBTC -> BTC) is the chain source rather than
    // checkpointSource().chain because it is populated for every configured coin whether
    // or not a co-located checkpoint DB exists, so the RPC-only deployment shape still
    // scopes correctly. A configured-but-unreachable hub still fails loud past the stale
    // ceiling; the co-located read below serves only the no-hub shape.
    // type in {status, block}; 'block' reuses the platform-wide type name (reorg_height IS
    // a block height) rather than inventing 'height'.
    async getReorgs(config){
        let ops   = this.explorer.hubOperational;
        let chain = this.baseCoin ? (this.baseCoin[config.coin] || config.coin) : config.coin;
        if(ops && ops.enabled()){
            let rows = await ops.getReorgHistory({
                chain,
                status:       config.data.type=='status' ? config.data.search : undefined,
                reorg_height: config.data.type=='block'  ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('reorg_attestations');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'reorg_attestations');
        // Mandatory per-coin chain scope, appended AFTER the optional type filter (the
        // same placement getCrossChainMatches uses for its network filter), so the args
        // stay [<type filter?>, chain] in strict left-to-right text order.
        let chainFilter = ' AND m.source_chain=?';
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data + chainFilter;
        let query = `SELECT
                        m.id,
                        m.reorg_id,
                        m.source_chain,
                        m.reorg_height,
                        m.reorg_timestamp,
                        m.affected_chains,
                        m.validator_count,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + chainFilter + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let typeArgs = ['status','block'].includes(config.data.type) ? [config.data.search] : [];
        let args = [...typeArgs, chain];
        return [query, args, count];
    }

    // ── Hub operational-state pages (p2p_peers / consensus_state / configs /
    // telemetry_pings). These are hub-LOCAL operational tables with no on-chain
    // action and, unlike validator_capabilities/governance_*, no hub JSON-RPC read
    // surface at all, so they are served ONLY from the co-located hub DB via
    // hubSource (same host+creds as the indexer pool; #4138), which is therefore
    // mandatory for these four on any install that serves them. That is the reverse
    // of the three RPC-first tables above, where the co-located schema serves only
    // the no-hub shape and a configured-but-down hub fails loud. Each is
    // id-keyed (no action_index), so the paging cursor compares m.id (see
    // getQueryOffsetSql).

    // P2P peer roster the hub gossips with. type in {validator}. id-keyed.
    async getPeers(config){
        let sql = config.data.sql;
        let src = this.hubSource(config, 'p2p_peers');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.addr,
                        m.validator_id,
                        m.last_seen_at,
                        m.is_seed,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub consensus key/value state. type in {key}. id-keyed.
    async getConsensusState(config){
        let sql = config.data.sql;
        let src = this.hubSource(config, 'consensus_state');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.key_name,
                        m.value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub config-oracle parameter store (per coin/network/module). type in {coin, module}.
    // id-keyed.
    async getConfigs(config){
        let sql = config.data.sql;
        let src = this.hubSource(config, 'configs');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.coin,
                        m.network,
                        m.module,
                        m.param_name,
                        m.param_value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Anonymous xchain-node telemetry pings. type in {event, install, country}. id-keyed.
    // Privacy: ip_hash (a keyed HMAC of the source IP) is deliberately NOT selected;
    // only the anonymous install UUID + coarse country/region + software fingerprint
    // are surfaced.
    async getTelemetryPings(config){
        let sql = config.data.sql;
        let src = this.hubSource(config, 'telemetry_pings');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.install_id,
                        m.country,
                        m.region,
                        m.node_version,
                        m.os_platform,
                        m.os_release,
                        m.arch,
                        m.docker_version,
                        m.event,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }
}

module.exports = SyncFeedReaders.prototype;
