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
 * SQL statements for the cross-chain action-detail handlers
 * (src/action-detail/crosschain.js): CROSS_SETTLE, XCALL and XEXEC.
 ********************************************************************/

'use strict';

// Read one CROSS_SETTLE row; transaction-less, so blocks join off actions.block_index.
const CROSS_SETTLE_DETAIL = `SELECT
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

// Read one XCALL request or expire row from xcalls.
const XCALL_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// Read the target-chain execution outcome of an XCALL by call_id.
const XCALL_EXECUTION = `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`;

// Read the source-chain callback delivery of an XCALL by call_id.
const XCALL_CALLBACK = `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`;

// Read a v1 result-delivery marker by its own action_index (it has no xcalls row).
const XCALL_RESULT_DELIVERY = `SELECT call_id, result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE action_index=? LIMIT 1`;

// Read one XEXEC row; transaction-less, so blocks join off actions.block_index.
const XEXEC_DETAIL = `SELECT
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

module.exports = {
    CROSS_SETTLE_DETAIL,
    XCALL_DETAIL,
    XCALL_EXECUTION,
    XCALL_CALLBACK,
    XCALL_RESULT_DELIVERY,
    XEXEC_DETAIL
};
