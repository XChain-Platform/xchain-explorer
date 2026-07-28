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
 * Detail handlers for the cross-chain actions: XCALL requests, the XEXEC
 * execution anchor and the CROSS_SETTLE DEX settlement leg.
 ********************************************************************/

'use strict';

const CROSS_SETTLE = {
    // CROSS_SETTLE action (mirror-injected cross-chain DEX settlement leg; the internal
    // action the indexer mints when it releases a local ORDER/SWAP against a signed
    // cross_chain_matches row). Transaction-less, same join shape as XEXEC. Both leg
    // references (a_chain/a_action_index, b_chain/b_action_index) and the local offer
    // released (local_action_index) are captured at settle time in cross_chain_settlements,
    // keyed by this action's own action_index; match_id ties it to the settled match.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    a1.action_format,
                    m.action_index,
                    m.match_id,
                    m.local_action_index,
                    m.a_chain,
                    m.a_action_index,
                    m.b_chain,
                    m.b_action_index,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    cross_chain_settlements m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const XCALL = {
    effects: { credits: false, debits: false, escrows: false },
    // XCALL action (cross-chain call request v0 / expire v2). VM-emitted; the
    // execution outcome + callback delivery are attached post-query by call_id.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // XCALL: parse the params JSON arrays and attach the target-chain execution
    // outcome + source-chain callback delivery (each by call_id; null until the
    // call is relayed/executed/delivered). Mirrors getXcall's lifecycle assembly.
    async afterMain({ db, config, action_index }, data) {
        if(data['call_id']) {
            try { data['params'] = db.util.isNull(data['params_json']) ? null : JSON.parse(data['params_json']); }
            catch(_) { data['params'] = data['params_json']; }
            try { data['callback_params'] = db.util.isNull(data['callback_params_json']) ? null : JSON.parse(data['callback_params_json']); }
            catch(_) { data['callback_params'] = data['callback_params_json']; }
            let exec = await db.doQuery(config,
                `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [data['call_id']]);
            data['execution'] = (exec && exec.length) ? exec[0] : null;
            let cb = await db.doQuery(config,
                `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [data['call_id']]);
            data['callback_delivery'] = (cb && cb.length) ? cb[0] : null;
        }
        // XCALL v1 (result-delivery marker): the indexer mints this action with
        // NO xcalls row (versions 0=request/2=expire live in xcalls; v1's data
        // lives only in cross_chain_call_callbacks), so the XCALL branch returned
        // nothing and the de-blank fallback populated baseline fields with a NULL
        // call_id. Resolve the delivered result by this action's own action_index
        // and tag it version 1 so the client renders a 'Result delivery (v1)'
        // shape instead of a blank 'Request (v0)' page.
        if(db.util.isNull(data['call_id'])) {
            let cbv1 = await db.doQuery(config,
                `SELECT call_id, result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE action_index=? LIMIT 1`, [action_index]);
            if(cbv1 && cbv1.length){
                data['version']  = 1;
                data['call_id']  = cbv1[0].call_id;
                data['result_status'] = cbv1[0].result_status;
                data['callback_delivery'] = {
                    callback_result_status: cbv1[0].result_status,
                    callback_block_index:   cbv1[0].callback_block_index
                };
            }
        }
    },
};

const XEXEC = {
    // XEXEC action (mirror-injected cross-chain call execution; the rollback anchor
    // the indexer mints when a quorum-signed cross_chain_calls dispatch is applied on
    // this chain). Transaction-less: no wire tx, so block joins via actions.block_index
    // and transactions is LEFT joined. The execution outcome (result_status / gas /
    // return payload) and the injected EXECUTE it drove live in cross_chain_call_executions,
    // keyed by this action's own action_index. call_id links back to the source dispatch.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    a1.action_format,
                    m.action_index,
                    m.call_id,
                    m.execute_action_index,
                    m.result_status,
                    m.return_payload_b64,
                    m.gas_used,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    cross_chain_call_executions m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

module.exports = {
    CROSS_SETTLE,
    XCALL,
    XEXEC
};
