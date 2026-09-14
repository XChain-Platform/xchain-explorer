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
 * SQL statements for the contract lifecycle action-detail handlers
 * (src/action-detail/contracts.js): DEPLOY, EXECUTE, DEPOSIT and WITHDRAW.
 ********************************************************************/

'use strict';

// Read an action's format byte, which picks between the two DEPLOY detail statements below.
const ACTION_FORMAT_PROBE = 'SELECT action_format FROM actions WHERE action_index=? LIMIT 1';

// Read a format-4 DEPLOY chunk carrier's own row from deploy_chunks.
const DEPLOY_CHUNK_DETAIL = `SELECT
                        a2.action,
                        a1.action_format,
                        m.action_index,
                        a3.address as source,
                        m.code_hash,
                        m.chunk_index,
                        m.total_chunks,
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
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        m.action_index=?
                    LIMIT 1`;

// Read a v0-v3 DEPLOY's contracts row and resolve where its contract landed.
// The two resolution columns, in one round trip rather than a follow-up:
//   deployed_contract_index  this action's own index when its own row deployed
//                            (an inline deploy, or a group already complete from
//                            lower carriers); else the index of the action that
//                            completed the group, which is the contract_executions
//                            row pointing back here through assembler_action_index,
//                            and only when THAT deployment came out valid; else
//                            null, meaning no contract exists for this assembler.
//   assembly_status          why the index is what it is, and the only terminal
//                            signal a polling client gets: an assembler consumed
//                            by a hash mismatch or a drained source at the
//                            completing carrier is never getting a contract, so
//                            its consumer's invalid status is reported here rather
//                            than leaving `pending: ...` to be polled forever.
// At most one execution row can name a given assembler (a group is consumed once),
// so the LIMIT 1 picks a row, not a winner among several.
const DEPLOY_CONTRACT_DETAIL = `SELECT
                        a2.action,
                        a1.action_format,
                        m.action_index,
                        a3.address as source,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name    as contract_meta_name,
                        m.meta_version as contract_meta_version,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        CASE WHEN s1.status='valid' THEN m.action_index ELSE (
                            SELECT e1.action_index
                            FROM contract_executions e1
                            LEFT JOIN index_statuses es1 ON (es1.id=e1.status_id)
                            WHERE e1.assembler_action_index=m.action_index AND es1.status='valid'
                            LIMIT 1) END as deployed_contract_index,
                        CASE WHEN s1.status='valid' THEN s1.status ELSE COALESCE((
                            SELECT es2.status
                            FROM contract_executions e2
                            LEFT JOIN index_statuses es2 ON (es2.id=e2.status_id)
                            WHERE e2.assembler_action_index=m.action_index
                            LIMIT 1), s1.status) END as assembly_status
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        m.action_index=?
                    LIMIT 1`;

// Read the contract a chunk carrier deployed at its own action_index, if any.
const DEPLOY_CARRIER_CONTRACT = `SELECT
                c1.action_index,
                c1.api_version,
                c1.cooldown_blocks,
                sd1.address as slash_destination,
                c1.meta_name,
                c1.meta_version,
                cs1.status as contract_status
             FROM
                contracts c1
                LEFT JOIN index_addresses sd1 ON (sd1.id=c1.slash_destination_id)
                LEFT JOIN index_statuses  cs1 ON (cs1.id=c1.status_id)
             WHERE
                c1.action_index=?
             LIMIT 1`;

// Read which DEPLOY assembler the execution at this action_index consumed.
const DEPLOY_ASSEMBLER = `SELECT
                e1.assembler_action_index
             FROM
                contract_executions e1
             WHERE
                e1.action_index=?
             LIMIT 1`;

// Read one EXECUTE row with the called contract's declared identity.
const EXECUTE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.contract_index,
                    a3.address as caller,
                    -- An EXECUTE served no top-level source, so the shared transaction card
                    -- rendered a dash beside an Action Details card that showed the very same
                    -- address as the caller. For a top-level call the two ARE the same address;
                    -- for one emitted by a contract (a nested EXECUTE) the action's own source
                    -- is the emitting contract while caller stays whoever triggered it.
                    a5.address as source,
                    m.method_name,
                    m.input_params,
                    m.gas_used,
                    m.gas_limit,
                    m.emitted_count,
                    m.error_message,
                    c1.meta_name    as contract_meta_name,
                    c1.meta_version as contract_meta_version,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    contract_executions m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=m.caller_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN contracts          c1 ON (c1.action_index=m.contract_index)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// List the actions an EXECUTE emitted, in emission order.
const EXECUTE_EMISSIONS = `SELECT position, emitted_action, action_index
             FROM contract_emissions WHERE execution_index=? ORDER BY position ASC`;

// Build the DEPOSIT or WITHDRAW detail read; custodyTable is 'deposits' or
// 'withdrawals', chosen by the handler from the action type, never from input.
function depositWithdrawDetail(custodyTable) {
    return `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.contract_index,
                    a3.address as source,
                    tk.tick,
                    m.amount,
                    c1.meta_name    as contract_meta_name,
                    c1.meta_version as contract_meta_version,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    ` + custodyTable + ` m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                    LEFT  JOIN index_tickers      tk ON (tk.id=m.tick_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN contracts          c1 ON (c1.action_index=m.contract_index)
                WHERE
                    m.action_index=?
                LIMIT 1`;
}

module.exports = {
    ACTION_FORMAT_PROBE,
    DEPLOY_CHUNK_DETAIL,
    DEPLOY_CONTRACT_DETAIL,
    DEPLOY_CARRIER_CONTRACT,
    DEPLOY_ASSEMBLER,
    EXECUTE_DETAIL,
    EXECUTE_EMISSIONS,
    depositWithdrawDetail
};
