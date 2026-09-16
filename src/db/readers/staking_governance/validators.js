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
 * XChain Explorer - validator lists and the hub registry legs
 *
 * The active validator set, the federation registry and capability rows the
 * hub serves (for the list and for one pubkey), per-validator attestation
 * quality and full-node verification results. Every hub-backed reader here
 * follows the same dual transport: hub JSON-RPC first, the co-located hub
 * schema only where no hub is configured.
 *
 * One part of src/db/readers/staking_governance.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

class ValidatorListReaders {
    async getValidators(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE s1.status='valid' AND ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.version,
                        m.amount,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE s1.status='valid' AND ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // What the hub knows about each signing pubkey, keyed by LOWERCASED pubkey. There
    // is no separate federation-registry page; these hub-only columns are folded onto
    // the on-chain active set that /validators already renders, so one table answers
    // both "who is staked on chain" and "what does the hub know about that key".
    //
    // Two sources, merged. The hub's manual `validators` registry (registervalidator:
    // addr, chains, status) wins when it has a row, but membership is the on-chain
    // stake set and nothing populates that registry on a live federation, so on its
    // own it labelled every staked validator, the hub's own peers included,
    // "unregistered". The gossiped validator_capabilities rows are what the hub
    // actually learns over P2P: a pubkey with any row has peered with this hub, and
    // it is `active` once one capability is qualified, self-tested and enabled, else
    // `peered`. A pubkey in neither source is one the hub has never heard from.
    //
    // Hub JSON-RPC first (HubOperationalCache, TTL-cached), co-located hub schema as
    // the fallback, for both sources. This is DELIBERATELY the one exception to the
    // fail-loud rule the three list endpoints follow: the registry only decorates
    // rows that /validators already renders from on-chain state, so a hub outage
    // must degrade the decoration, never blank a page of consensus data. Returns
    // NULL when neither source is reachable at all (no hub endpoint configured, hub
    // down past the stale ceiling, and no co-located hub schema). Null is the
    // "unknown" signal: the caller must not render it as "not registered".
    async getFederationRegistry(config){
        let rows = null;
        let ops  = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            try { rows = await ops.getFederationValidators(); }
            catch(e){ log.info('FEDERATION_REGISTRY_RPC_FAILED', { err: e && e.message }); }
        }
        if(!rows){
            try {
                let src = this.hubSource(config, 'validators');
                rows = await this.doQuery(config,
                    'SELECT signing_pubkey, addr, chains, status FROM ' + src.table, []);
            } catch(e){
                if(this.configInfo.env.DEBUG) log.debug('FEDERATION_REGISTRY_SCHEMA_FAILED', { err: e && e.message ? e.message : e });
                rows = null;
            }
        }
        let caps = await this.federationCapabilityRows(config, ops);
        if(!Array.isArray(rows) && !Array.isArray(caps)) return null;
        let registry = {};
        for(let row of (Array.isArray(rows) ? rows : [])){
            if(!row || this.util.isNull(row.signing_pubkey)) continue;
            // `chains` is absent on a hub older than the getvalidators column add;
            // absent and NULL both mean "the hub did not say", never the string
            // "undefined".
            registry[String(row.signing_pubkey).toLowerCase()] = {
                addr:   this.util.isNull(row.addr)   ? null : String(row.addr),
                chains: this.util.isNull(row.chains) ? null : String(row.chains),
                status: this.util.isNull(row.status) ? null : String(row.status)
            };
        }
        // One flag per pubkey: active if ANY capability is fully on. The gossip
        // carries no network address or chain list, so those stay null here.
        let peered = {};
        for(let row of (Array.isArray(caps) ? caps : [])){
            if(!row || this.util.isNull(row.signing_pubkey)) continue;
            let key    = String(row.signing_pubkey).toLowerCase();
            let active = Number(row.qualified) === 1 && Number(row.self_test_ok) === 1 &&
                         Number(row.enabled) === 1;
            peered[key] = Boolean(peered[key]) || active;
        }
        for(let key of Object.keys(peered)){
            if(registry[key]) continue;
            registry[key] = { addr: null, chains: null, status: peered[key] ? 'active' : 'peered' };
        }
        return registry;
    }

    // Every validator_capabilities row the hub holds, on the same dual transport the
    // capability list view uses. Null means this source is unreachable, which is not
    // an outage by itself: getFederationRegistry needs BOTH sources gone before it
    // reports unknown.
    async federationCapabilityRows(config, ops){
        if(ops && ops.enabled() && typeof ops.getValidatorCapabilities === 'function'){
            try {
                let rows = await ops.getValidatorCapabilities({});
                if(Array.isArray(rows)) return rows;
            } catch(e){
                log.info('FEDERATION_CAPABILITY_RPC_FAILED', { err: e && e.message });
            }
        }
        try {
            let src  = this.hubSource(config, 'validator_capabilities');
            let rows = await this.doQuery(config,
                'SELECT signing_pubkey, qualified, self_test_ok, enabled FROM ' + src.table, []);
            return Array.isArray(rows) ? rows : null;
        } catch(e){
            if(this.configInfo.env.DEBUG) log.debug('FEDERATION_CAPABILITY_SCHEMA_FAILED', { err: e && e.message ? e.message : e });
            return null;
        }
    }

    // Per-validator per-capability qualification flags. type in {capability, pubkey}.
    // id-keyed. Primary transport: hub JSON-RPC via HubOperationalCache (these are
    // hub-LOCAL operational rows, not consensus mirror data). The co-located hub
    // schema read below serves ONLY the no-hub deployment shape; a configured hub
    // that is unreachable past the stale ceiling fails loud.
    async getValidatorCapabilities(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getValidatorCapabilities({
                capability:     config.data.type=='capability' ? config.data.search : undefined,
                signing_pubkey: config.data.type=='pubkey'     ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('validator_capabilities');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'validator_capabilities');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.signing_pubkey,
                        m.capability,
                        m.qualified,
                        m.self_test_ok,
                        m.enabled,
                        m.qualified_at_block,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator per-provider ATTEST accountability rollup (indexer-owned counters).
    // fulfilled_count/missed_count are live (incremented per verified signature and per
    // expired-round absence by xchain-indexer's incrementAttestationValidatorStat);
    // slashed_count and quality_score are Phase 4 columns the indexer defines and defaults
    // to 0 but has no producer for yet. The table carries no action_index (rows are
    // upsert-incremented counters, not action-chain rows); it pages on the surrogate m.id
    // added for exactly this purpose, NOT on last_updated_block, which ties whenever a
    // whole ATTEST responsible set misses in one block and so would split a keyset page
    // boundary. type in {pubkey, provider}.
    async getAttestValidatorStats(config){
        let sql   = config.data.sql;
        let count = `SELECT count(*) as total FROM attest_validator_stats m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.validator_pubkey,
                        m.provider_id,
                        m.fulfilled_count,
                        m.missed_count,
                        m.slashed_count,
                        m.quality_score,
                        m.last_updated_block
                    FROM
                        attest_validator_stats m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of FULL-NODE VERIFICATION records (NODEPROOF v0 possession-proof verdicts).
    // One row per (epoch, verified validator): the validator answered the derived possession
    // challenge for `epoch_height` correctly, as recorded by a quorum-signed NODEPROOF verdict.
    // signing_pubkey resolves the verified full node (index_pubkeys); staking_source resolves
    // the stake the share dedupes by (index_addresses on m.source_id); source is the verdict
    // submitter. Like the sibling list views this is ordered newest-first by m.id.
    async getFullNodeVerifications(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        full_node_verifications m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.challenge_id,
                        m.epoch_height,
                        m.target_height,
                        m.signing_pubkey_id,
                        pk.pubkey as signing_pubkey,
                        m.source_id,
                        a3.address as staking_source,
                        a2.address as source,
                        m.passed,
                        m.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        full_node_verifications m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-capability qualification rows for ONE signing pubkey, on the same dual transport
    // getValidatorCapabilities serves the list view over. Kept as its own helper so the
    // composition cannot drift into a second, differently-degrading copy of that rule.
    // The RPC leg filters server-side by signing_pubkey; an EMPTY array back is a legitimate
    // "qualified for nothing", while a null past the stale ceiling is an OUTAGE and throws.
    //
    // The capability leg follows the established hub DUAL PATH (getValidatorCapabilities):
    // hub JSON-RPC first, the co-located hub schema only on a deployment with no hub
    // endpoint at all, and a CONFIGURED hub unreachable past the stale ceiling throws
    // through hubOperationalOutage. That throw is not caught here: an outage rendered as
    // "this validator qualified for nothing" is a false claim about consensus state.
    async validatorCapabilityRows(config, pubkey, limit){
        let ops = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            let rows = await ops.getValidatorCapabilities({ signing_pubkey: pubkey });
            if(rows) return this.normalizeHubOperationalRows(rows.slice(0, limit));
            this.hubOperationalOutage('validator_capabilities');
        }
        let src  = this.hubSource(config, 'validator_capabilities');
        let rows = await this.doQuery(config,
            `SELECT
                m.id,
                m.signing_pubkey,
                m.capability,
                m.qualified,
                m.self_test_ok,
                m.enabled,
                m.qualified_at_block,
                m.updated_at
            FROM ${src.table} m
            WHERE m.signing_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
        return this.normalizeHubOperationalRows(rows || []);
    }
}

module.exports = ValidatorListReaders.prototype;
