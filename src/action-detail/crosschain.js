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

const {
    CROSS_SETTLE_DETAIL,
    XCALL_DETAIL,
    XCALL_EXECUTION,
    XCALL_CALLBACK,
    XCALL_RESULT_DELIVERY,
    XEXEC_DETAIL
} = require('../db/action_detail/crosschain_sql');

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
        query = CROSS_SETTLE_DETAIL;
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
        query = XCALL_DETAIL;
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
            let exec = await db.doQuery(config, XCALL_EXECUTION, [data['call_id']]);
            data['execution'] = (exec && exec.length) ? exec[0] : null;
            let cb = await db.doQuery(config, XCALL_CALLBACK, [data['call_id']]);
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
            let cbv1 = await db.doQuery(config, XCALL_RESULT_DELIVERY, [action_index]);
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
        query = XEXEC_DETAIL;
        return { query, query2, query3 };
    },
};

module.exports = {
    CROSS_SETTLE,
    XCALL,
    XEXEC
};
