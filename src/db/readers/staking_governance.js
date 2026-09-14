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
 * XChain Explorer - staking, validator and governance readers
 *
 * stakes and unstakes, validators and the federation registry, prices and
 * oracle prices, controllers and delegations, contract stakes, slash events,
 * validator capabilities, cross-chain matches and the governance feeds.
 * One of the reader families extracted out of db.js.
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
 ********************************************************************/

'use strict';

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../observability');
const log = getLogger();

class StakingGovernanceReaders {
    async getStakes(config){
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
                    WHERE ` + sql.where.data;
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
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of capability UNSTAKE actions (UNSTAKE v0; the `unstakes` table). A capability
    // unstake begins the global cooldown on a staked signing key; contract-targeted unstakes
    // (UNSTAKE v1) live in contract_unstakes and have their own list view. Mirrors getStakes
    // minus the token join. type in {block, address, source}; not in actionTables, so it serves
    // the newest page ordered by m.action_index DESC.
    async getUnstakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        // ROLLCALL evictions (action_format 3) write an unstakes row with tx_index NULL
        // (no broadcast transaction behind them), so blocks joins off a1.block_index
        // (always set, synthetic or not) and transactions is LEFT so the eviction row
        // survives instead of vanishing from an INNER join it can never satisfy.
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.amount,
                        m.cooldown_end_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of DELEGATE key-revocation actions (DELEGATE v2/v3; the `stake_key_revocations`
    // table). A revocation invalidates a stake's signing key as of deactivation_block. Mirrors
    // getUnstakes. type in {block, address, source}; ordered newest-first by m.action_index.
    async getStakeKeyRevocations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        stake_key_revocations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        stake_key_revocations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

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

    // Get list of PRICE actions. The batch WINDOW columns (batch_first_round /
    // batch_last_round / round_count) are selected because a validator PRICE is a batch
    // and its single-round columns are NULL by construction, so without them a list row
    // says nothing at all about what the action carried. rounds_json is deliberately NOT
    // selected here: one batch is an hour of rounds times dozens of COIN/FIAT pairs, so
    // a page of them would run to megabytes. The full bodies are served per action by
    // the PRICE detail handler (src/action-detail/consensus.js).
    async getPrices(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        prices m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        a2.address as source,
                        m.round_number,
                        m.round_timestamp,
                        m.pair_count,
                        m.pairs_json,
                        m.sig_count,
                        m.sigs_json,
                        m.batch_first_round,
                        m.batch_last_round,
                        m.round_count,
                        -- A batch stores NULL pair_count (it would describe one round out of the
                        -- window), so the list row's pair count is the width of the batch's FIRST
                        -- round: every round in a batch is one publisher's full snapshot. Counted
                        -- server-side rather than shipped as rounds_json, which is megabytes a page.
                        JSON_LENGTH(m.rounds_json, '$[0].pairs') as batch_pair_count,
                        c1.coin,
                        t3.tick,
                        f1.code as fiat,
                        m.value,
                        m.fee,
                        m.validation_status,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        prices m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of hub-mirrored price_snapshots rows (federation PRICE v0 consensus
    // snapshots replicated by hub_db_sync). Never replicated by xchain-sync, so the
    // read is database-qualified to the mandatory co-located hub schema and fails loud
    // without one (item 4063); see oracleMirrorSource.
    async getPriceSnapshots(config){
        let sql   = config.data.sql;
        let src   = this.oracleMirrorSource(config, 'price_snapshots');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.round_number,
                        m.coin_pair,
                        m.price,
                        m.reference_block,
                        m.reference_chain,
                        m.block_timestamp,
                        m.validator_count,
                        m.consensus_round,
                        m.consensus_proof,
                        m.status,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of hub-mirrored oracle_prices rows (user-published PRICE v1 oracle rows
    // replicated by hub_db_sync). These are the aggregated hub-effective published-oracle
    // prices that feed oracle-priced DISPENSERs. type in {token, address}.
    // Never replicated by xchain-sync, so the read is database-qualified to the
    // mandatory co-located hub schema and fails loud without one (item 4062);
    // see oracleMirrorSource.
    async getOraclePrices(config){
        let sql   = config.data.sql;
        let src   = this.oracleMirrorSource(config, 'oracle_prices');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.source_address,
                        m.source_chain,
                        m.coin,
                        m.tick,
                        m.fiat,
                        m.value,
                        m.fee,
                        m.memo,
                        m.block_time,
                        m.effective_at,
                        m.action_index,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Controller bind/unbind event stream (programmable-policy guards, controller-bound-tokens.md).
    // UNION of BOTH logs: token_controllers (ISSUE-bound, per-tick) + address_controllers
    // (ADDRESS-bound, self-signed). Each is append-only (one immutable row per bind/unbind); the
    // *effective* gating set is resolved on the token/address detail pages; this list surfaces the
    // raw events. status is the literal 'valid': the indexer records a controller event ONLY while
    // applying a valid bind/unbind, and reorg rollback DELETEs the rows (DELETE WHERE action_index >=
    // orphan), so every surviving row is a valid event by construction. (We do NOT join the parent
    // action table for status; an ADDRESS v1 controller-bind never writes the `addresses` table,
    // which is the fee-preference variant, so that join would always be NULL → false 'invalid'.)
    // Like the sibling VM list views (getExecutions/getContracts), this is not in actionTables, so the
    // cursor-offset optimizer no-ops and the list serves the newest page ordered by m.action_index DESC.
    controllerUnionSql(){
        return `
            SELECT
                c.action_index       AS action_index,
                'token'              AS scope,
                b1.block_index       AS block_index,
                b1.block_time        AS timestamp,
                tk.tick              AS subject,
                c.action_class       AS action_class,
                c.contract_index     AS contract_index,
                c.is_unbind          AS is_unbind,
                c.cooldown_blocks    AS cooldown_blocks,
                c.cooldown_end_block AS cooldown_end_block,
                'valid'              AS status,
                signer.address       AS bound_by
            FROM token_controllers c
                INNER JOIN actions        a1     ON (a1.action_index=c.action_index)
                INNER JOIN transactions   t1     ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks         b1     ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_tickers  tk     ON (tk.id=c.tick_id)
                LEFT  JOIN index_addresses signer ON (signer.id=c.bound_by_id)
            UNION ALL
            SELECT
                c.action_index       AS action_index,
                'address'            AS scope,
                b1.block_index       AS block_index,
                b1.block_time        AS timestamp,
                ad.address           AS subject,
                c.action_class       AS action_class,
                c.contract_index     AS contract_index,
                c.is_unbind          AS is_unbind,
                c.cooldown_blocks    AS cooldown_blocks,
                c.cooldown_end_block AS cooldown_end_block,
                'valid'              AS status,
                NULL                 AS bound_by
            FROM address_controllers c
                INNER JOIN actions         a1 ON (a1.action_index=c.action_index)
                INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_addresses ad ON (ad.id=c.address_id)
        `;
    }

    async getControllers(config){
        let sql   = config.data.sql;
        let union = this.controllerUnionSql();
        let count = `SELECT count(*) as total FROM ( ` + union + ` ) m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        m.scope,
                        m.block_index,
                        m.timestamp,
                        m.subject,
                        m.action_class,
                        m.contract_index,
                        m.is_unbind,
                        m.cooldown_blocks,
                        m.cooldown_end_block,
                        m.status,
                        m.bound_by
                    FROM ( ` + union + ` ) m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Chunked DEPLOY carriers (DEPLOY v4): one base64 code slice per row in deploy_chunks. The
    // assembler reassembles the VALID chunks of a (source, code_hash) group into the final contract
    // source (DEPLOY.md); the assembled contract itself appears under Contracts. This list surfaces
    // each on-chain carrier (its chunk position + group size + status). code_part (the base64 slice)
    // is intentionally NOT selected on list rows; it is a MEDIUMTEXT payload too heavy for a paged
    // list. Rows carry code_part_length instead, and the full slice rides the single-action surface
    // (attachActionDetailSupplements). Not in actionTables (sibling of getExecutions); serves the
    // newest page ordered by m.action_index DESC.
    async getDeployChunks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        deploy_chunks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code_hash,
                        m.chunk_index,
                        m.total_chunks,
                        CHAR_LENGTH(m.code_part) as code_part_length,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        deploy_chunks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getValidatorRewards(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        validator_rewards m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.reward_type,
                        m.round_reference,
                        m.amount,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        validator_rewards m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of COLLECT actions (validator reward claims; the `reward_claims` table). Each row
    // is one on-chain claim of accrued capability-validator rewards by the broadcasting address.
    // The per-reward-type accrual ledger is validator_rewards (getValidatorRewards); this is the
    // claim event. type in {block, address, source}; ordered newest-first by m.action_index.
    async getCollects(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        reward_claims m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        reward_claims m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
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

    async getContractStakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.version,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getContractUnstakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.cooldown_end_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of CONTRACT DELEGATION actions (DELEGATE v1/v3, type in {address, block, contract}).
    // Mirrors getContractStakes; contract_delegations carries no amount/version; the delegation
    // re-points a stake's signing pubkey, with activation/deactivation block bounds.
    async getContractDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of VOTE v3 delegation rows (liquid democracy, type in {tick, delegator,
    // delegate, block}). vote_delegations is an APPEND-ONLY event log: a holder can set,
    // re-point, or clear (revoke) their standing per-token delegation, and every one of
    // those actions writes a NEW row rather than mutating the old one, so a naive
    // SELECT * shows every revoked/superseded delegation as if it were still live.
    //
    // The live delegation for a (tick_id, delegator) is its LATEST row (highest
    // action_index), and only if that latest row is not a CLEAR (delegate_address_id IS
    // NOT NULL). This mirrors xchain-indexer's Database#getActiveDelegations (which feeds
    // getPollTally) exactly, minus its `block_index <= ?` bound: that bound answers "what
    // was live AT some past height", which a poll close needs; this list answers "what is
    // live now", so the bound is simply omitted. Every TYPE narrows WHICH keys are shown,
    // never what "live" means.
    //
    // Implemented as a correlated MAX on the (tick_id, delegator_address_id) key, in the
    // outer WHERE where the paging cursor also lives - never a GROUP BY over a "newest N
    // rows" derived table, which is the defect class that a cursor applied OUTSIDE the
    // window silently truncates.
    async getVoteDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        t3.tick,
                        dgr.address as delegator,
                        dg.address as delegate,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2  ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4  ON (a4.id=a1.action_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
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

    // Get list of cross-chain MATCH records (type ∈ {match, block, status}; block = snapshot_block).
    // cross_chain_matches is a standalone mirror of the hub's finalized match table with no
    // actions/transactions chain, so no joins; ordered by the mirror cursor m.id.
    // validator_signatures (the 2f+1 quorum proof) is included: matches have no separate
    // detail endpoint, and the proof is the point of inspecting one.
    async getCrossChainMatches(config){
        let sql   = config.data.sql;
        // cross_chain_matches is hub-mirrored: xchain-sync never replicates it, so it is
        // served only from the mandatory co-located hub DB, never from a stale local mirror.
        // matchSource throws (fail loud) if no co-located hub DB is configured for this coin.
        // The hub table is multi-network, so a network filter rides along; it appends one `?`
        // AFTER any type filter in sql.where.data, so the returned args must be ordered
        // [<type filter?>, network].
        let src   = this.matchSource(config);
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter;
        let query = `SELECT
                        m.id,
                        m.match_id,
                        m.snapshot_block,
                        m.network,
                        m.a_chain,
                        m.a_action_index,
                        m.a_kind,
                        m.a_tick,
                        m.a_amount,
                        m.a_filled_before,
                        m.a_ownership,
                        m.a_payout_addr,
                        m.b_chain,
                        m.b_action_index,
                        m.b_kind,
                        m.b_tick,
                        m.b_amount,
                        m.b_filled_before,
                        m.b_ownership,
                        m.b_payout_addr,
                        m.effective_time,
                        m.validator_signatures,
                        m.status,
                        m.batch_root,
                        m.anchor_txid,
                        m.finalizing_view,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Non-redirect path: keep args null (baseArgs defaults to [config.data.search],
        // current behavior). Redirect path: supply explicit args so the network `?` binds;
        // [config.data.search] only when a type filter (match/block/status) added its own `?`.
        let args = null;
        if(src.networkParam !== null){
            let typeArgs = ['match','block','status'].includes(config.data.type) ? [config.data.search] : [];
            args = [...typeArgs, src.networkParam];
        }
        return [query, args, count];
    }

    async getCrossChainSettlements(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        m.match_id,
                        m.local_action_index,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of SLASH events (xchain.contract.slash emissions, type in {address, block, contract})
    // slash_events has no action_index of its own (side-effect of an EXECUTE), so this joins
    // blocks directly via m.block_index and orders by m.id rather than action_index.
    async getSlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.execution_index,
                        m.target_contract_index,
                        a3.pubkey as slashed_pubkey,
                        a4.address as destination,
                        t3.tick,
                        m.amount,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of capability_slash_events (equivocation bond-burns against consensus validators).
    // Mirrors getSlashEvents; joins blocks directly via m.block_index.
    // type in {block, capability, pubkey, address} where address matches the submitter.
    async getCapabilitySlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        capability_slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.slash_action_index,
                        pk.pubkey as slashed_pubkey,
                        m.capability,
                        m.equiv_key,
                        m.amount,
                        m.bounty_amount,
                        m.treasury_amount,
                        sub.address as submitter,
                        dst.address as destination,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        capability_slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
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

    // Governance parameter proposals. type in {status, parameter, proposal}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud; this table is the clearest
    // case for it, since governance_proposals carries no freshness column
    // at all, so a per-row freshness cap on the schema read is unbuildable.
    async getGovernanceProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceProposals({
                status:      config.data.type=='status'    ? config.data.search : undefined,
                parameter:   config.data.type=='parameter' ? config.data.search : undefined,
                proposal_id: config.data.type=='proposal'  ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('governance_proposals');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'governance_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.proposer_pubkey,
                        m.parameter,
                        m.current_value,
                        m.proposed_value,
                        m.status,
                        m.voting_end,
                        m.activation_block
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator governance votes. type in {proposal, voter}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud.
    async getGovernanceVotes(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceVotes({
                proposal_id:  config.data.type=='proposal' ? config.data.search : undefined,
                voter_pubkey: config.data.type=='voter'    ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('governance_votes');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'governance_votes');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.voter_pubkey,
                        m.vote,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Federation slash proposals (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's NEW unauthenticated
    // getslashproposals RPC (added for this row alongside the hub-side evidence
    // hashing). Unlike reorg_attestations there is NO chain column and none is
    // missing: the offenses are federation-wide (oracle and attestation rounds are
    // not per-chain, and a signing pubkey is one identity across every chain), so
    // this table is platform-global like validator_capabilities/governance_* and
    // binds no chain filter on either transport. Adding one later would empty this
    // page permanently, since no row can ever carry a chain value to match.
    //
    // Rows with status 'pending' are UNADJUDICATED ACCUSATIONS: SlashDetector
    // records evidence, and only a passed SLASH_PENALTY governance vote moves a row
    // off 'pending' (SlashGovernance.applyFinalized). status is therefore carried on
    // every row and rendered as its own labelled column, never as a row colour.
    //
    // The verbatim `evidence` blob is NEVER served on either leg. The RPC leg gets
    // evidence_hash from the hub (SlashDetector.hashEvidence, sha256 of the stored
    // text, the same digest SlashGovernance's voted evidence hash is built from);
    // the co-located leg computes the identical digest in SQL. Hashing hub-side is
    // the ruling's point: the hub's own POST surface serves this RPC to anyone, so
    // explorer-side redaction alone would leak.
    //
    // A configured-but-unreachable hub fails loud past the stale ceiling
    // (hubOperationalOutage); the co-located read below serves only the no-hub
    // deployment shape. type in {status, pubkey}, matching the hub RPC's two
    // server-side filters exactly, so neither transport post-filters. No 'block'
    // type: round_number is an oracle round (or an attestation pseudo-round), not a
    // block height.
    async getSlashProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getSlashProposals({
                status:           config.data.type=='status' ? config.data.search : undefined,
                validator_pubkey: config.data.type=='pubkey' ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('slash_proposals');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'slash_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.validator_pubkey,
                        m.offense_type,
                        m.round_number,
                        SHA2(COALESCE(m.evidence,''), 256) AS evidence_hash,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Composed VALIDATOR detail (M4.1). QUERY is EITHER the Ed25519 signing pubkey or the
    // staking address: both name the same validator in circulation (/validators renders both
    // columns, a hub registry entry is keyed by pubkey, a reward accrual and its COLLECT are
    // keyed by address), so the page answers to either without the caller having to say
    // which it holds.
    //
    // The QUERY is resolved to IDs FIRST, in two unique point reads, and only then does the
    // spine touch `stakes`. The obvious one-query form (`WHERE a3.pubkey=? OR a2.address=?`
    // over the joined aliases) reads correctly and scans the whole stakes table: an OR
    // spanning two different joined tables leaves the optimizer no driving table but `stakes`
    // itself. Resolving first puts the OR on two INDEXED columns of `stakes`
    // (signing_pubkey_id, source_id), which index-merges. The single-predicate list legs
    // below keep the joined-alias form: one null-rejecting equality lets the optimizer
    // convert the LEFT JOIN and drive from the unique index, which an OR does not.
    //
    // Reward accounting is per-ADDRESS, not per-pubkey: validator_rewards accrues to
    // (source_id, signing_pubkey_id) but reward_claims (the COLLECT trail) carries only
    // source_id, so a claimable figure can only be stated for the staking address. Both
    // totals are returned alongside the difference rather than the difference alone, because
    // a negative remainder means ledger drift and has to stay visible instead of clamping.
    //
    // The capability leg follows the established hub DUAL PATH (getValidatorCapabilities):
    // hub JSON-RPC first, the co-located hub schema only on a deployment with no hub
    // endpoint at all, and a CONFIGURED hub unreachable past the stale ceiling throws
    // through hubOperationalOutage. That throw is not caught here: an outage rendered as
    // "this validator qualified for nothing" is a false claim about consensus state.
    async getValidator(config){
        let limit  = this.detailLimit(config);
        let search = config.data.search;
        let pubkeyRow  = await this.doQuery(config,
            'SELECT id FROM index_pubkeys WHERE pubkey=? LIMIT 1', [search]);
        let addressRow = await this.doQuery(config,
            'SELECT id FROM index_addresses WHERE address=? LIMIT 1', [search]);
        let pubkeyId  = (pubkeyRow  && pubkeyRow.length)  ? Number(pubkeyRow[0].id)  : null;
        let addressId = (addressRow && addressRow.length) ? Number(addressRow[0].id) : null;
        // Neither name exists anywhere on this chain: answer without touching `stakes`.
        if(pubkeyId === null && addressId === null)
            return [null];
        // Only the resolved side is bound, so a QUERY that is unambiguously one form
        // never carries a dead placeholder against the other column's index.
        let idClauses = [];
        let idArgs    = [];
        if(pubkeyId !== null){  idClauses.push('m.signing_pubkey_id=?'); idArgs.push(pubkeyId);  }
        if(addressId !== null){ idClauses.push('m.source_id=?');         idArgs.push(addressId); }
        // Identity spine. status='valid' matches getValidators' own active-set rule, so the
        // page cannot resolve an identity off a rejected STAKE.
        let identity = await this.doQuery(config,
            `SELECT
                a3.pubkey  as signing_pubkey,
                a2.address as source,
                m.action_index as stake_action_index,
                m.version,
                m.activation_block,
                m.deactivation_block,
                m.block_index
            FROM
                stakes m
                LEFT JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND (` + idClauses.join(' OR ') + `)
            ORDER BY m.action_index DESC
            LIMIT 1`, idArgs);
        if(!identity || !identity.length)
            return [null];
        let row    = identity[0];
        let pubkey = row.signing_pubkey;
        let source = row.source;

        // Active stake: an aggregate over ONE pubkey's rows (signing_pubkey_id is indexed),
        // never a GROUP BY across validators. deactivation_block IS NULL is what "still
        // active" means on this ledger; a superseded row carries the height it stopped at.
        let totals = await this.doQuery(config,
            `SELECT
                count(*) as position_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as active_stake
            FROM
                stakes m
                LEFT JOIN index_pubkeys  a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND a3.pubkey=? AND m.deactivation_block IS NULL`, [pubkey]);

        let stakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let unstakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let delegations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                delegations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Key revocations belong with the delegation history rather than in a section of
        // their own: a DELEGATE v2/v3 revocation is the event that ENDS a delegated key's
        // validity, and reading it apart from the delegation it ends inverts the meaning.
        let revocations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stake_key_revocations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Rotations name BOTH the key they replaced and the key they installed, so this key
        // is on either side of the pair and both are matched. See the frontier note: neither
        // pubkey column is indexed on contract_delegation_rotations today.
        let rotations = await this.doQuery(config,
            `SELECT
                m.id,
                m.target_table,
                m.delegation_action_index,
                m.stake_action_index,
                pp.pubkey as prev_signing_pubkey,
                np.pubkey as new_signing_pubkey,
                m.block_index,
                b1.block_time as timestamp
            FROM
                contract_delegation_rotations m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys pp ON (pp.id=m.prev_signing_pubkey_id)
                LEFT  JOIN index_pubkeys np ON (np.id=m.new_signing_pubkey_id)
            WHERE (pp.pubkey=? OR np.pubkey=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey, pubkey]);

        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                m.derive_block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let claimable = await this.collectTrail(config, source, limit);

        // Both slash families. capability_slash_events is the equivocation bond-burn against
        // a CONSENSUS validator (keyed by the signing pubkey directly); slash_events is the
        // contract-stake burn emitted by an EXECUTE (also keyed by the staker's pubkey). One
        // family alone understates exposure, which is why the page carries both. The row
        // shape matches getCapabilitySlashEvents and the address staking panel (slashed
        // key + submitter + destination), so the same slash reads identically wherever
        // it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                a3.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let nodeproofs = await this.doQuery(config,
            `SELECT
                m.id,
                m.action_index,
                m.challenge_id,
                m.epoch_height,
                m.target_height,
                a3.address as staking_source,
                m.passed,
                m.block_index,
                b1.block_time as timestamp
            FROM
                full_node_verifications m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses a3 ON (a3.id=m.source_id)
            WHERE pk.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        // Attestation quality is keyed by the RAW pubkey string (attest_validator_stats has
        // no index_pubkeys id), one row per provider the validator serves.
        let attestationQuality = await this.doQuery(config,
            `SELECT
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
            WHERE m.validator_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let capabilities = await this.validatorCapabilityRows(config, pubkey, limit);

        // The hub registry decorates, never gates: getFederationRegistry returns null when
        // no registry is reachable at all, and null means UNKNOWN, not "unregistered".
        let registry = await this.getFederationRegistry(config);
        let entry    = (registry && pubkey) ? registry[String(pubkey).toLowerCase()] : null;

        return [{
            query:              search,
            signing_pubkey:     pubkey,
            source:             source,
            stake_action_index: row.stake_action_index,
            version:            row.version,
            activation_block:   row.activation_block,
            deactivation_block: row.deactivation_block,
            block_index:        row.block_index,
            registry:           (entry) ? entry : null,
            registry_known:     (registry !== null),
            active_stake:       this.util.bcformat((totals && totals.length) ? totals[0].active_stake : 0, 8),
            position_count:     (totals && totals.length) ? Number(totals[0].position_count) : 0,
            capabilities:       capabilities,
            stakes:             stakes      || [],
            unstakes:           unstakes    || [],
            delegations:        delegations || [],
            revocations:        revocations || [],
            rotations:          rotations   || [],
            rewards:            rewards     || [],
            rewards_total:      claimable.rewards_total,
            collected_total:    claimable.collected_total,
            claimable:          claimable.claimable,
            collects:           claimable.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || [],
            nodeproofs:              nodeproofs        || [],
            attestation_quality:     attestationQuality || []
        }];
    }

    // The COLLECT trail for ONE staking address, shared by the validator page and the
    // address staking panel so the two can never disagree about what "claimable" means.
    // Accrual (validator_rewards) minus claims (reward_claims), both summed in SQL over an
    // indexed source_id lookup rather than over a fetched page, because a page-local sum
    // would silently under-report the moment a validator has more rows than one page.
    async collectTrail(config, source, limit){
        let accrued = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM validator_rewards m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
             WHERE a2.address=?`, [source]);
        let claimed = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM reward_claims m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
             WHERE s1.status='valid' AND a2.address=?`, [source]);
        let collects = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                reward_claims m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [source]);
        // One wire type for all three figures: a fixed-8 decimal STRING, matching how
        // every other XCHAIN amount is serialized. The SQL sums come back at the CAST's
        // 18 decimal places and bcsub returns a mathjs bignumber OBJECT, so both are
        // formatted rather than passed through; an unformatted bignumber serializes as a
        // mathjs envelope, not as a number a page can print.
        let accruedTotal = (accrued && accrued.length) ? accrued[0].total : 0;
        let claimedTotal = (claimed && claimed.length) ? claimed[0].total : 0;
        return {
            rewards_total:   this.util.bcformat(accruedTotal, 8),
            collected_total: this.util.bcformat(claimedTotal, 8),
            claimable:       this.util.bcformat(this.util.bcsub(accruedTotal, claimedTotal, 8), 8),
            collects:        collects || []
        };
    }

    // Per-capability qualification rows for ONE signing pubkey, on the same dual transport
    // getValidatorCapabilities serves the list view over. Kept as its own helper so the
    // composition cannot drift into a second, differently-degrading copy of that rule.
    // The RPC leg filters server-side by signing_pubkey; an EMPTY array back is a legitimate
    // "qualified for nothing", while a null past the stale ceiling is an OUTAGE and throws.
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

    // Composed ADDRESS STAKING panel (M4.6). One address, four questions the raw tabs below
    // it cannot answer together: what is staked, what is cooling down and when it matures,
    // what is claimable, and what has been slashed out from under it.
    //
    // Maturity is computed against the indexer's own tip (getMaxBlockIndex), not wall clock,
    // so every explorer host answers identically and the number matches the consensus rule
    // that releases the funds.
    //
    // Slash exposure has to reach the address through the KEYS it staked with, because
    // neither slash table carries an address of the slashed party: capability_slash_events
    // and slash_events both name a signing pubkey. So each family is scoped by the pubkey set
    // this address staked, drawn from the ledger that family actually burns from (`stakes`
    // for the capability family, `contract_stakes` for the contract family). Scoping both
    // from one ledger would over- or under-report, depending which one was picked.
    async getAddressStaking(config){
        let limit   = this.detailLimit(config);
        let address = config.data.search;
        if(this.util.isNull(address)) return [null];
        let tip = await this.getMaxBlockIndex(config);

        let positions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityPositions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let cooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityCooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        for(let row of [...(cooldowns || []), ...(capabilityCooldowns || [])]){
            let end = Number(row.cooldown_end_block);
            row.blocks_remaining = Math.max(0, end - tip);
            row.matured          = tip >= end;
        }

        let trail = await this.collectTrail(config, address, limit);
        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                a3.pubkey as signing_pubkey,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a2.address=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        // Row shape matches getCapabilitySlashEvents and the validator page's slash
        // leg (slashed key + submitter + destination), so the same slash reads
        // identically wherever it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                pk.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT s.signing_pubkey_id FROM stakes s
                    INNER JOIN index_addresses sa ON (sa.id=s.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                pk.pubkey as slashed_pubkey,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT cs.signing_pubkey_id FROM contract_stakes cs
                    INNER JOIN index_addresses sa ON (sa.id=cs.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        return [{
            address:              address,
            chain_tip:            tip,
            positions:            positions           || [],
            capability_positions: capabilityPositions || [],
            cooldowns:            cooldowns           || [],
            capability_cooldowns: capabilityCooldowns || [],
            rewards:              rewards             || [],
            rewards_total:        trail.rewards_total,
            collected_total:      trail.collected_total,
            claimable:            trail.claimable,
            collects:             trail.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || []
        }];
    }
}

module.exports = StakingGovernanceReaders.prototype;
