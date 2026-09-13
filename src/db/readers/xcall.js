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
 * XChain Explorer - cross-chain call, anchor and attestation readers
 *
 * Proposal B stage 4: the XCALL request and execution feeds and one call's
 * composed detail, the ANCHOR list, one anchor's detail and its commitments, and
 * the ATTEST request/response pairs with the expiry correlation that links an
 * ATTEST v2 expiry back to the request it resolved.
 *
 * The expiry helpers are the reason these three families share a module. An
 * expiry writes no row of its own: it flips a status column and stamps a block
 * on the request, so the only way to render "this request expired" is to
 * correlate the later action back onto the earlier one, and XCALL and ATTEST
 * both do it the same way against rows an anchor commits.
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

class XcallReaders {
    // Get list of ATTEST actions from the consolidated `attests` table. Lists both
    // v0 (request) and v1 (response) rows; `version` + request/response status let
    // the UI tell them apart. type in {address, block, contract}.
    //
    // The block is resolved off the ACTION's own block_index and `transactions` is a
    // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
    // ATTEST v1 response is a system-synthesized action with a real action_index and
    // block_index but a NULL tx_index and no transactions row (attest-response-mirror
    // spec §4.4), so the older INNER chain through t1 made every such response
    // VANISH from this list rather than render incompletely. tx_hash and tx_index
    // come back NULL for those rows, which is what they are.
    async getAttestations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        // The block is resolved off the ACTION's own block_index and `transactions` is a
        // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
        // ATTEST v1 response is a system-synthesized action with a real action_index and
        // block_index but a NULL tx_index and no transactions row (attest-response-mirror
        // spec §4.4), so the older INNER chain through t1 made every such response
        // VANISH from this list rather than render incompletely. tx_hash and tx_index
        // come back NULL for those rows, which is what they are.
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.gas_escrow,
                        m.fee_amount,
                        ft.tick as fee_tick,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.response_payload,
                        m.callback_params_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                        LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List XCALL cross-chain call requests (xcalls table, VM-emitted, read-only).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / source contract / request_status (see getQueryWhereSql getXcalls branch).
    async getXcalls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List ANCHOR checkpoint records from anchor_actions. Joins the
    // actions/transactions/blocks chain like getAttestations/getXcalls.
    // type in {block, chain, network, status}.
    //
    // A v0 BUNDLE is N sibling rows sharing one action_index, one per checkpointed
    // chain, each carrying its own chain/block_index/checkpoint_seq/roots. That is
    // exactly why the bundle was stored one row per section: every per-chain reader,
    // this list and its `chain` filter included, keeps working unchanged and simply
    // lists the section rows. section_index is projected so a reader can tell two
    // sections of one bundle apart, and it breaks the ORDER BY tie the shared
    // action_index would otherwise leave to the server.
    async getAnchors(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        m.section_index,
                        a1.action_format,
                        m.version,
                        m.chain,
                        m.network,
                        m.block_index,
                        m.block_hash,
                        m.ledger_hash,
                        m.actions_hash,
                        m.contract_hash,
                        m.checkpoint_seq,
                        m.snapshot_block,
                        m.match_batch_seq,
                        m.match_count,
                        m.batch_crc32,
                        m.total_chunks,
                        m.chunk_index,
                        m.state_root,
                        m.state_root_version,
                        m.block_merkle_root,
                        m.block_merkle_version,
                        m.validator_signatures,
                        m.block_index_doge,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `, m.section_index ASC
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-block SPV commitments (state_tree_roots), decorated with the covering
    // hub-mirrored state_checkpoints row (if any) and the local ANCHOR action that carried
    // it (if any). The three legs live in three places and are not casually joinable:
    // state_tree_roots is this coin's own indexer DB (no action chain, one row per block,
    // unique on (chain, network, block_index)); state_checkpoints is the co-located
    // hub-mirror schema reached via checkpointSource, DB-qualified but on the SAME
    // connection pool as the indexer DB (checkpointDb is registered ONLY when it shares
    // host/port/user/pass with that pool), which is exactly what the co-location guarantee
    // is FOR; anchor_actions is this same coin's own local indexer DB, parsed from the
    // DOGE-only ANCHOR action, so on a non-DOGE deployment that leg is structurally always
    // empty - the same limitation getAnchors already carries reading the same table.
    //
    // Both decoration legs are LEFT JOINs correlated on this row's own block_index, so a
    // block with no covering checkpoint yet (normal near the tip: checkpoints cut on a
    // cadence) or no carrying ANCHOR yet (anchoring batches several heights) comes back
    // with those columns NULL rather than the row vanishing. checkpointSource still
    // throws when this coin has no co-located hub DB configured at ALL, which is a
    // deployment misconfiguration and a different case entirely.
    //
    // Reuses the exact latest-per-height predicate getCheckpoints established rather than
    // a third, differently-bounded checkpoint query, and applies the identical shape to
    // the anchor leg's own latest-checkpoint_seq-per-height lookup.
    async getCommitments(config){
        let sql      = config.data.sql;
        let src      = this.checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this.latestCheckpointPredicate(src, 'sc');
        // anchor_actions.chain/network name the CHECKPOINTED chain (the same convention
        // state_checkpoints uses), not the chain the ANCHOR transaction landed on, so this
        // coin's own (chain, network) identity is the correct filter here too: block_index
        // alone is not unique across chains on the DOGE deployment, where one local table
        // holds commitments for all three.
        let anFilter = ' AND an.chain = ? AND an.network = ?';
        let anLatest = ` AND an.checkpoint_seq = (SELECT MAX(a2.checkpoint_seq) FROM anchor_actions a2
                           WHERE a2.block_index = an.block_index AND a2.chain = ? AND a2.network = ?)`;
        let count = `SELECT
                        count(*) as total
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.block_index,
                        m.balances_root,
                        m.stakes_root,
                        m.state_root,
                        m.block_merkle_root,
                        m.contract_state_root,
                        m.computed_at,
                        sc.checkpoint_seq        AS checkpoint_seq,
                        sc.snapshot_block        AS checkpoint_snapshot_block,
                        sc.created_at            AS checkpoint_created_at,
                        JSON_LENGTH(sc.validator_signatures) AS checkpoint_signer_count,
                        an.action_index          AS anchor_action_index,
                        an.version               AS anchor_version
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.block_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Left-to-right text order: both JOIN ON clauses (checkpoint filter + latest, then
        // anchor filter + latest), then the WHERE type-bound value, which is present only
        // when type='block' (getData's list-all null filter drops the trailing undefined on
        // a bare request, so the placeholder count still lines up). count and list share
        // IDENTICAL FROM+JOIN text, so this one array binds correctly against both.
        let args = [...src.filterParams, ...latest.params, ...src.filterParams, ...src.filterParams, config.data.search];
        return [query, args, count];
    }

    // Full XCALL lifecycle by call_id: the source request (xcalls) + the target-chain
    // execution outcome (cross_chain_call_executions) + the source-chain callback
    // delivery (cross_chain_call_callbacks). The latter two are null until the call is
    // relayed/executed/delivered. Mirrors getContract's single-item return ([data]);
    // data is null when the call_id is unknown. A call_id can carry more than one
    // xcalls row (rejected attempts index alongside the accepted request), so the
    // read is pinned to the valid row, matching the indexer's authoritative
    // by-call_id lookup; without the status bound the ORDER BY can surface an
    // invalid row as the lifecycle.
    async getXcall(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.params_json,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.callback_params_json,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.result_payload,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + ` AND s1.status='valid'
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // params/callback_params are JSON arrays on the wire; parse, falling back to
            // the raw string on malformed JSON (mirrors getContract's permissions parse).
            try { row.params = this.util.isNull(row.params_json) ? null : JSON.parse(row.params_json); }
            catch(e){ row.params = row.params_json; }
            try { row.callback_params = this.util.isNull(row.callback_params_json) ? null : JSON.parse(row.callback_params_json); }
            catch(e){ row.callback_params = row.callback_params_json; }
            // Target-chain execution outcome (1:1 by call_id; null until executed).
            let exec = await this.doQuery(config,
                `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.execution = (exec && exec.length) ? exec[0] : null;
            // Source-chain callback delivery (1:1 by call_id; null until delivered).
            let cb = await this.doQuery(config,
                `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.callback_delivery = (cb && cb.length) ? cb[0] : null;
            data = row;
        }
        return [data];
    }

    // ATTEST v2 (expire) mints an action and writes NO ROW, so `attests` names neither
    // side of the pair. The two are correlated POSITIONALLY WITHIN THE BLOCK, which is
    // exact rather than a guess, because the indexer fixes both orders:
    //   - the sweep selects what it expires in ONE deterministic order
    //     (xchain-indexer db.getExpiredAttestationRequests: deadline_block ASC,
    //     action_index ASC) and mints one v2 action per selected request in that loop,
    //     so the v2 action indexes ascend in exactly that order;
    //   - request_status 'expired' is written by that sweep and by NOTHING else (the
    //     v1/v3/v4 response paths write only 'fulfilled' or 'errored'; a retryable
    //     round leaves the request pending), so the two lists cover the same set.
    // Equal length is therefore an INVARIANT, and it is checked rather than assumed:
    // a block where the two disagree yields no link at all, because a rank correlation
    // over unequal lists names the WRONG request, which is worse than naming none.
    //
    // The rank machinery is only load-bearing for a block that expired several requests
    // at once; the common block carries one of each.
    async correlateAttestationExpiries(config, blockIndex){
        if(this.util.isNull(blockIndex)) return [];
        // Bounded well above the indexer's per-block expiry cap
        // (ATTEST_MAX_EXPIRIES_PER_BLOCK = 25) so a raised cap widens the read instead of
        // silently truncating one list and disabling the correlation.
        let cap = 100;
        let acts = await this.doQuery(config,
            `SELECT
                a1.action_index
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.block_index=? AND a2.action='ATTEST' AND a1.action_format=2
            ORDER BY a1.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!acts || !acts.length) return [];
        let reqs = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.request_id,
                m.provider_id,
                m.contract_index,
                m.callback_method,
                m.deadline_block,
                m.request_status,
                m.resolved_block
            FROM attests m
            WHERE m.version=0 AND m.request_status='expired' AND m.resolved_block=?
            ORDER BY m.deadline_block ASC, m.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!reqs || reqs.length !== acts.length) return [];
        return acts.map((a, i) => ({
            expire_action_index: a.action_index,
            request:             reqs[i]
        }));
    }

    // The v2 expire action that retired one v0 request row, or null when the block's
    // two lists do not line up (see correlateAttestationExpiries).
    async resolveAttestationExpireAction(config, request){
        if(!request || String(request.request_status) !== 'expired') return null;
        let pairs = await this.correlateAttestationExpiries(config, request.resolved_block);
        let hit   = pairs.find(p => p.request && String(p.request.request_id) === String(request.request_id));
        return (hit) ? hit.expire_action_index : null;
    }

    // The inverse read, for the ACTION page of a v2: the v0 request this expire retired.
    async resolveAttestationExpireRequest(config, expireActionIndex, blockIndex){
        let pairs = await this.correlateAttestationExpiries(config, blockIndex);
        let hit   = pairs.find(p => Number(p.expire_action_index) === Number(expireActionIndex));
        return (hit) ? hit.request : null;
    }

    // Seed the lifecycle page from a v2 expire's own action_index. Reads the action's
    // block (the expire writes no attests row, so there is nothing else to key on) and
    // hands back the correlated v0 request row.
    async seedAttestationFromExpireAction(config, actionIndex){
        if(!this.util.isNumeric(actionIndex)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                a1.block_index,
                a1.action_format
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.action_index=? AND a2.action='ATTEST' AND a1.action_format=2
            LIMIT 1`, [Number(actionIndex)]);
        if(!rows || !rows.length) return null;
        return await this.resolveAttestationExpireRequest(config, Number(actionIndex), rows[0].block_index);
    }

    // The system-injected callback EXECUTE for one request.
    //
    // attests.callback_execute_action_index is stamped on the v1 RESPONSE row only
    // (xchain-indexer setAttestationResponseCallbackIndex ... WHERE version = 1), so an
    // EXPIRED request has no stored link anywhere: the v2 sweep injects the expired
    // callback (_injectExpiredCallback) and there is no v1 row to stamp. The execution
    // itself is unambiguous on its own columns: the injected EXECUTE calls the request's
    // OWN contract and callback method with the request_id as its first positional
    // parameter (INPUT_PARAMS is the '|'-joined argument list), and a request id is
    // unique chain-wide, so this identifies exactly the callback for THIS request.
    //
    // The id is re-validated as 64 hex before it reaches the LIKE: a request_id is the
    // only user-influenced part of the pattern and hex carries no % or _ wildcard.
    async deriveAttestationCallbackExecute(config, request){
        if(!request) return null;
        let requestId = String(request.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(requestId)) return null;
        if(this.util.isNull(request.contract_index) || this.util.isNull(request.callback_method)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index
            FROM contract_executions m
            WHERE m.contract_index=? AND m.method_name=? AND m.input_params LIKE CONCAT(?, '|%')
            ORDER BY m.action_index ASC
            LIMIT 1`, [request.contract_index, request.callback_method, requestId]);
        return (rows && rows.length) ? rows[0].action_index : null;
    }

    // Composed ATTESTATION lifecycle (M4.3). QUERY is EITHER the 64-hex request_id (the
    // correlation key every leg carries) or the action_index of any ATTEST action in the
    // round. A numeric QUERY resolves through getAttestationByActionIndex, the positional-arg
    // point read the WS ChangeDetector already owns: it is REUSED here rather than re-routed
    // or reshaped, because the detector depends on its signature exactly as it stands.
    //
    // WHAT THE SCHEMA FORCED, and it contradicts the obvious reading of the lifecycle:
    // ATTEST v2 (expire) writes NO ROW OF ITS OWN. It is system-synthesized, allocates an
    // action_index with FORMAT 2, and then only FLIPS the v0 request row's request_status to
    // 'expired' and stamps resolved_block (xchain-indexer attest.js parseExpire). So the
    // expiry leg below is DERIVED from the request row, not selected from a v2 row. The
    // expire ACTION does exist and has a working page, so it is resolved through the
    // in-block correlation above and named here rather than declared unlinkable.
    //
    // Relay legs (ATTEST v3/v4) likewise write ordinary version 0 / version 1 rows carrying
    // origin_chain + origin_action_index, so they arrive in the same request_id read; the
    // relay block below names them rather than issuing a second query for rows that are by
    // construction on ANOTHER chain's indexer DB.
    async getAttestation(config){
        let limit  = this.detailLimit(config);
        let search = config.data.search;
        let requestId = null;
        if(this.util.isNumeric(search)){
            let seed = await this.getAttestationByActionIndex(config, Number(search));
            // A v2 expire has no attests row, so the point read answers nothing for it and
            // the lifecycle page for the expire's own action_index rendered NOT FOUND. The
            // in-block correlation resolves it to the request it retired.
            if(!seed) seed = await this.seedAttestationFromExpireAction(config, Number(search));
            if(!seed) return [null];
            requestId = seed.request_id;
        } else {
            requestId = String(search || '').toLowerCase();
        }
        if(!requestId) return [null];

        // Every leg of one round in one bounded read, oldest first so the caller renders the
        // lifecycle in the order it happened. request_id+version is indexed.
        //
        // `blocks` resolves off the action's own block_index, not the transaction's: a
        // mirror-applied response has an action_index but no transaction row, and routing
        // through t1 left the timestamp NULL for it (attest-response-mirror spec section 4.4).
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                a1.action_format,
                m.version,
                m.request_id,
                m.provider_id,
                m.contract_index,
                a2.address as source,
                fp.address as fee_payer,
                m.payload,
                m.callback_method,
                m.callback_params_json,
                m.redundancy,
                m.deadline_block,
                m.gas_escrow,
                ft.tick as fee_tick,
                m.fee_amount,
                m.request_status,
                m.resolved_block,
                m.responsible_set_json,
                m.origin_chain,
                m.origin_action_index,
                m.response_hash,
                m.response_payload,
                m.response_status,
                m.meta,
                m.validator_signatures,
                m.callback_execute_action_index,
                m.batch_action_index,
                m.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                attests m
                LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN blocks              b1 ON (b1.block_index=a1.block_index)
                LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                LEFT JOIN index_tickers       ft ON (ft.id=m.fee_tick_id)
                LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                LEFT JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                LEFT JOIN index_actions       a4 ON (a4.id=a1.action_id)
            WHERE m.request_id=?
            ORDER BY m.version ASC, m.action_index ASC
            LIMIT ` + limit, [requestId]);
        if(!rows || !rows.length) return [null];

        let request  = rows.find(r => Number(r.version) === 0) || null;
        let response = rows.find(r => Number(r.version) === 1) || null;
        if(request){
            try { request.callback_params = this.util.isNull(request.callback_params_json) ? null : JSON.parse(request.callback_params_json); }
            catch(e){ request.callback_params = request.callback_params_json; }
            // The responsible set was PINNED as-of the request block; it is the electorate a
            // reader checks the response signatures against, so it is parsed, not echoed raw.
            request.responsible_set = this.parseSignaturesArray(request.responsible_set_json);
        }
        if(response)
            response.quorum_signatures = this.parseSignaturesArray(response.validator_signatures);

        let status = (request) ? request.request_status : null;

        // The stored callback link lives on the v1 RESPONSE row alone, so an EXPIRED
        // request - which has no v1 row at all - reported "no callback execution
        // recorded" while the injected expired-callback EXECUTE sat on chain a couple of
        // indexes away. Derive it for that case, and flag the derivation so the page can
        // say where the link came from instead of implying the indexer stamped it.
        let callbackIndex   = (response) ? response.callback_execute_action_index : null;
        let callbackDerived = false;
        let expireAction    = null;
        if(request && status === 'expired'){
            expireAction = await this.resolveAttestationExpireAction(config, request);
            if(this.util.isNull(callbackIndex)){
                callbackIndex   = await this.deriveAttestationCallbackExecute(config, request);
                callbackDerived = !this.util.isNull(callbackIndex);
            }
        }

        return [{
            query:      config.data.search,
            request_id: requestId,
            provider_id: rows[0].provider_id,
            legs:       rows,
            request:    request,
            response:   response,
            // Derived, because ATTEST v2 persists no ROW. It does mint an ACTION, and
            // expire_action_index names it (null when the block's expire actions and
            // expired requests do not line up). `expired` is the stored terminal state,
            // never a clock comparison against deadline_block: a request past its deadline
            // that the expiry sweep has not reached yet is still 'pending'.
            expiry: {
                request_status:      status,
                deadline_block:      (request) ? request.deadline_block : null,
                resolved_block:      (request) ? request.resolved_block : null,
                expired:             status === 'expired',
                expire_action_index: expireAction
            },
            relay: {
                is_relay:            !!(request && !this.util.isNull(request.origin_chain)),
                origin_chain:        (request) ? request.origin_chain : null,
                origin_action_index: (request) ? request.origin_action_index : null,
                response_relayed:    !!(response && !this.util.isNull(response.origin_action_index))
            },
            callback_execute_action_index: callbackIndex,
            callback_execute_derived:      callbackDerived
        }];
    }

    // Composed ANCHOR detail (M4.5). QUERY is the ANCHOR's action_index, or the DOGE
    // transaction hash it landed in. The two are told apart in JS rather than bound into one
    // OR: action_index is a BIGINT column and a 64-hex hash compared against it is coerced,
    // not matched, so an OR would answer 0 rows for the hash form without erroring.
    //
    // Three legs beyond the payload, and each reads a DIFFERENT source:
    //   - the covering hub-mirror state_checkpoints row, through the SAME correlated
    //     latest-checkpoint_seq-per-height predicate getCheckpoints/getCommitments use
    //     (latestCheckpointPredicate), never a fourth differently-bounded variant;
    //   - the publisher ELECTION, from capability_snapshots at this anchor's snapshot_block.
    //     That table is CHAIN-AGNOSTIC (no chain/network columns; its key is
    //     snapshot_block+capability+signing_pubkey+source), so src.filter/filterParams are
    //     deliberately NOT bound to it;
    //   - the reward-attestation trail, from anchor_reward_attestations, which IS
    //     chain-scoped (chain/network are in uq_reward_tuple), so the same src.filter IS
    //     bound there, first, exactly as getAnchorRewardAttestations binds it.
    // Getting that asymmetry backwards yields a query that is silently wrong rather than one
    // that errors, in whichever direction the blanket rule was applied.
    //
    // archive_b64 is never selected. It is a MEDIUMTEXT gzip chunk with nothing legible in
    // it; its LENGTH and crc32 are what a reader can actually check an archive against.
    async getAnchor(config){
        let limit  = this.detailLimit(config);
        let search = config.data.search;
        let numeric   = this.util.isNumeric(search);
        let predicate = numeric ? 'm.action_index=?' : 't2.hash=?';
        let key       = numeric ? Number(search) : String(search || '').toLowerCase();
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                m.section_index,
                a1.action_format,
                m.version,
                m.chain,
                m.network,
                m.block_index,
                m.block_hash,
                m.ledger_hash,
                m.actions_hash,
                m.contract_hash,
                m.checkpoint_seq,
                m.snapshot_block,
                m.state_root,
                m.state_root_version,
                m.block_merkle_root,
                m.block_merkle_version,
                m.match_batch_seq,
                m.match_count,
                m.batch_crc32,
                m.total_chunks,
                m.chunk_index,
                CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                m.validator_signatures,
                m.publisher,
                m.publisher_attestations,
                m.block_index_doge,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                anchor_actions m
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
            WHERE ` + predicate + `
            ORDER BY m.action_index DESC, m.section_index ASC
            LIMIT 1`, [key]);
        if(!rows || !rows.length) return [null];
        let row = rows[0];
        row.validator_signatures   = this.parseSignaturesArray(row.validator_signatures);
        // The v4/v5/v6 XANCPUB tail is RAW WIRE transport, not the quorum-verified subset
        // (anchor_actions.sql), so it is parsed for display and named as attestations to
        // re-verify, never presented as a verified quorum.
        row.publisher_attestations = this.parseSignaturesArray(row.publisher_attestations);

        // A v0 ANCHOR is a BUNDLE: one action carrying every checkpointed chain, stored as
        // N sibling rows sharing one action_index at section_index 0..N-1. Each row holds
        // its OWN chain, block_index, checkpoint_seq, roots and validator signatures; the
        // bundle-level fields (version, network, publisher, publisher_attestations, status,
        // txid, the DOGE block it landed in) are denormalized identically onto every row,
        // which is why the spine above can serve as the header no matter which section it
        // matched. Archive rows (v1/v2) and every retired per-chain version stay at
        // section_index 0, so they take no second query at all.
        //
        // snapshot_block on the header is the BUNDLE's block, the MAX over the sections: a
        // chain that lagged rides at its own older SECTION_SNAPSHOT_BLOCK, but the election
        // and the publisher attestation were both drawn at the MAX. Reading section 0's
        // block as the bundle's would look the electorate up at the wrong height.
        row.sections      = [];
        row.section_count = 1;
        if(Number(row.version) === 0){
            let sections = await this.doQuery(config,
                `SELECT
                    m.section_index,
                    m.chain,
                    m.network,
                    m.block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.action_index=?
                ORDER BY m.section_index ASC
                LIMIT ` + limit, [Number(row.action_index)]) || [];
            row.sections = sections.map(s => {
                s.validator_signatures = this.parseSignaturesArray(s.validator_signatures);
                return s;
            });
            if(row.sections.length){
                row.section_count = row.sections.length;
                let blocks = row.sections
                    .map(s => this.util.isNull(s.snapshot_block) ? null : Number(s.snapshot_block))
                    .filter(v => v !== null);
                if(blocks.length) row.snapshot_block = Math.max(...blocks);
            }
        }

        // Continuation chunks (v2) share the archive batch id. Bounded: a large archive
        // splits into as many chunks as it needs, so this list has no natural ceiling.
        let chunks = [];
        if(!this.util.isNull(row.match_batch_seq))
            chunks = await this.doQuery(config,
                `SELECT
                    m.action_index,
                    m.version,
                    m.chunk_index,
                    m.total_chunks,
                    CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                    m.block_index_doge,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.match_batch_seq=?
                ORDER BY m.chunk_index ASC
                LIMIT ` + limit, [row.match_batch_seq]) || [];

        let src         = this.checkpointSource(config);
        let scFilter    = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest      = this.latestCheckpointPredicate(src, 'sc');
        // The anchor names the CHECKPOINTED height on the CHECKPOINTED chain, which is what
        // state_checkpoints is keyed by too, so this coin's own (chain, network) identity is
        // the right filter here (the same reasoning getCommitments' anchor leg carries).
        //
        // A BUNDLE carries several chains at once, so the height to look up is THIS coin's
        // own section, not whichever section the spine happened to match. Keying a
        // chain-filtered mirror query by another chain's height cannot error: it returns
        // zero rows, and the page then reads a perfectly good bundle as uncovered.
        let localSection = row.sections.find(s =>
            String(s.chain || '').toUpperCase() === String(src.filterParams[0] || '').toUpperCase()) || null;
        let coveredHeight = localSection ? localSection.block_index : row.block_index;
        row.local_section_index = localSection ? localSection.section_index : null;
        let checkpoint = [];
        if(!this.util.isNull(coveredHeight))
            checkpoint = await this.doQuery(config,
                `SELECT
                    sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash,
                    sc.actions_hash, sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                    sc.state_root, sc.state_root_version, sc.block_merkle_root,
                    sc.block_merkle_version, sc.validator_signatures, sc.created_at
                FROM ${src.table} sc
                WHERE sc.block_index = ?${scFilter}${latest.sql}
                LIMIT 1`, [Number(coveredHeight), ...src.filterParams, ...latest.params]) || [];

        // Publisher election. capability_snapshots is CHAIN-AGNOSTIC: no chain/network
        // filter is bound, matching getCapabilitySnapshots. 'oracle_publish' is the
        // capability the publisher election draws its set from.
        let electorate = [];
        if(!this.util.isNull(row.snapshot_block))
            electorate = await this.doQuery(config,
                `SELECT
                    m.signing_pubkey,
                    m.amount,
                    m.source
                FROM ${src.capTable} m
                WHERE m.snapshot_block=? AND m.capability=?
                ORDER BY m.id ASC
                LIMIT ` + limit, [Number(row.snapshot_block), 'oracle_publish']) || [];

        // Reward trail. CHAIN-SCOPED, so filterParams lead. Correlated on the mined DOGE
        // txid this anchor landed in, OR on the table's own natural key minus publisher
        // (snapshot_block + the round this anchor closed: checkpoint_seq for a checkpoint
        // anchor, match_batch_seq for an archive one, the SNAPSHOT BLOCK itself for a v0
        // bundle, whose single anchor_bundle reward is keyed round_reference =
        // SNAPSHOT_BLOCK rather than to any one section's checkpoint_seq).
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let rounds = [row.checkpoint_seq, row.match_batch_seq,
                      (Number(row.version) === 0) ? row.snapshot_block : null]
            .filter(v => !this.util.isNull(v)).map(v => Number(v));
        let rewardWhere = 'm.doge_anchor_txid=?';
        let rewardArgs  = [...src.filterParams, row.tx_hash];
        if(rounds.length && !this.util.isNull(row.snapshot_block)){
            rewardWhere += ` OR (m.snapshot_block=? AND m.round_reference IN (${rounds.map(() => '?').join(',')}))`;
            rewardArgs.push(Number(row.snapshot_block), ...rounds);
        }
        let rewards = await this.doQuery(config,
            `SELECT
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
            FROM ${src.rewardTable} m
            WHERE 1=1` + outerFilter + ` AND (` + rewardWhere + `)
            ORDER BY m.id DESC
            LIMIT ` + limit, rewardArgs) || [];

        row.chunks             = chunks;
        row.checkpoint         = (checkpoint.length) ? this.normalizeCheckpointRows(checkpoint)[0] : null;
        row.publisher_election = electorate;
        row.reward_attestations = rewards;
        return [row];
    }

    // XCALL phase transitions latched since the cursor's block (spec
    // explorer-coverage-completion M5.4). This is the XCALL analogue of
    // getBetFeedsClosedSince and exists for the same reason: the transition that ends a
    // call's life on the SOURCE chain - request_status going pending -> completed - is a
    // direct status write performed by the callback interlock, with NO action row of its
    // own for the ChangeDetector's actions cursor to find. `resolved_block` is the height
    // at which that write happened, so it is the cursor column.
    //
    // Expired calls are included even though XCALL v2 does mint an action row: the v2
    // action is a SEPARATE xcalls row (version 2) whose action name is XCALL, so a
    // subscriber filtering on the phase events would otherwise see completions but not
    // expiries, which is the asymmetry that makes a live timeline wrong rather than
    // merely incomplete. The event carries `synthetic` so a consumer can tell which of
    // the two had a causing action.
    // Current phase of ONE cross-chain call, for the WS `xcall` channel's SNAPSHOT
    // frame (spec explorer-coverage-completion M5.4). Sibling of getBetFeedInfo /
    // getDispenserInfo: a plain (config, key) point read that the WS server can call
    // without assembling a request config. Null when this chain has no row for the
    // call_id, which is a normal answer on the TARGET chain of a call.
    //
    // Pinned to the VALID row for the same reason getXcall is: a call_id can carry
    // more than one xcalls row (a rejected attempt indexes alongside the accepted
    // request), and a snapshot built from an invalid row would open the subscription
    // on a lifecycle that never happened.
    async getXcallInfo(config, callId){
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.call_id,
                m.contract_index,
                a2.address as source,
                m.target_chain,
                m.target_contract_index,
                m.method,
                m.gas_limit,
                m.deadline_block,
                m.request_status,
                m.result_status,
                m.resolved_block,
                m.callback_action_index,
                m.block_index,
                s1.status
            FROM
                xcalls m
                LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE m.call_id=? AND s1.status='valid'
            ORDER BY m.action_index DESC
            LIMIT 1`, [callId]);
        return (rows && rows.length) ? rows[0] : null;
    }

    async getXcallPhasesSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.call_id,
                        m.version,
                        m.contract_index,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        m.deadline_block,
                        a2.address as source,
                        s1.status
                    FROM
                        xcalls m
                        LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
                    WHERE
                        m.resolved_block > ?
                        AND m.request_status IN ('completed','expired')
                        AND s1.status='valid'
                    ORDER BY m.resolved_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationsSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.callback_params_json,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.block_index,
                        s1.status
                    FROM
                        attests m
                        LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                        LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                    WHERE
                        m.block_index > ?
                    ORDER BY m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationByActionIndex(config, action_index){
        let query = `SELECT
                        m.action_index, m.version, m.request_id, m.provider_id, m.contract_index,
                        m.request_status, m.response_status, m.payload, m.callback_params_json, m.block_index,
                        fp.address as fee_payer
                    FROM attests m
                        LEFT JOIN index_addresses fp ON (fp.id=m.fee_payer_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [action_index]);
        return (results && results.length) ? results[0] : null;
    }
}

module.exports = XcallReaders.prototype;
