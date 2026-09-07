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

    // The hub's own federation registry (`validators`: addr, chains,
    // registration status), keyed by LOWERCASED signing pubkey. There is no separate
    // federation-registry page; these hub-only columns are folded onto the on-chain
    // active set that /validators already renders, so one table answers both "who is
    // staked on chain" and "what does the hub know about that key".
    //
    // Hub JSON-RPC first (HubOperationalCache, TTL-cached), co-located hub schema as
    // the fallback. This is DELIBERATELY the one exception to the fail-loud rule the
    // three list endpoints follow: the registry only decorates rows that
    // /validators already renders from on-chain state, so a hub outage must degrade
    // the decoration, never blank a page of consensus data. Returns NULL when no
    // registry is reachable at all (no hub endpoint configured, hub down past the
    // stale ceiling, and no co-located hub schema). Null is the "unknown" signal:
    // the caller must not render it as "not registered".
    async getFederationRegistry(config){
        let rows = null;
        let ops  = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            try { rows = await ops.getFederationValidators(); }
            catch(e){ console.log('Federation registry RPC read failed: ' + (e && e.message)); }
        }
        if(!rows){
            try {
                let src = this._hubSource(config, 'validators');
                rows = await this.doQuery(config,
                    'SELECT signing_pubkey, addr, chains, status FROM ' + src.table, []);
            } catch(e){
                if(process.env.DEBUG) console.log('Federation registry schema read failed:', e);
                return null;
            }
        }
        if(!Array.isArray(rows)) return null;
        let registry = {};
        for(let row of rows){
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
        return registry;
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
    // without one (item 4063); see _oracleMirrorSource.
    async getPriceSnapshots(config){
        let sql   = config.data.sql;
        let src   = this._oracleMirrorSource(config, 'price_snapshots');
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
    // see _oracleMirrorSource.
    async getOraclePrices(config){
        let sql   = config.data.sql;
        let src   = this._oracleMirrorSource(config, 'oracle_prices');
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

    // Controller bind/unbind event stream (programmable-policy guards, Controller_Bound_Tokens.md).
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
    _controllerUnionSql(){
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
        let union = this._controllerUnionSql();
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
        // _matchSource throws (fail loud) if no co-located hub DB is configured for this coin.
        // The hub table is multi-network, so a network filter rides along; it appends one `?`
        // AFTER any type filter in sql.where.data, so the returned args must be ordered
        // [<type filter?>, network].
        let src   = this._matchSource(config);
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
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('validator_capabilities');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'validator_capabilities');
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
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('governance_proposals');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'governance_proposals');
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
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('governance_votes');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'governance_votes');
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
}

module.exports = StakingGovernanceReaders.prototype;
