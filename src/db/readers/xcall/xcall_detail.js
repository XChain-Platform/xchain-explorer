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
 * XChain Explorer - one cross-chain call: its lifecycle, phase and phase feed
 *
 * One part of src/db/readers/xcall.js (the entry composes it through
 * composeReaderParts). The composed XCALL detail page, the point read the WS
 * `xcall` channel snapshots from, and the since-cursor feed of the phase
 * transitions that write no action row of their own.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The rest of one call's lifecycle, hung onto its valid xcalls row: the parsed
// parameter arrays, then the target-chain execution and the source-chain callback
// delivery, read in that order. `db` is the Database instance getXcall runs on; this
// is a plain function rather than a method so Database.prototype gains no name.
async function attachXcallLifecycle(db, config, row){
    // params/callback_params are JSON arrays on the wire; parse, falling back to
    // the raw string on malformed JSON (mirrors getContract's permissions parse).
    try { row.params = db.util.isNull(row.params_json) ? null : JSON.parse(row.params_json); }
    catch(e){ row.params = row.params_json; }
    try { row.callback_params = db.util.isNull(row.callback_params_json) ? null : JSON.parse(row.callback_params_json); }
    catch(e){ row.callback_params = row.callback_params_json; }
    // Target-chain execution outcome (1:1 by call_id; null until executed).
    let exec = await db.doQuery(config,
        `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [row.call_id]);
    row.execution = (exec && exec.length) ? exec[0] : null;
    // Source-chain callback delivery (1:1 by call_id; null until delivered).
    let cb = await db.doQuery(config,
        `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [row.call_id]);
    row.callback_delivery = (cb && cb.length) ? cb[0] : null;
    return row;
}

class XcallDetailReaders {
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
        if(results && results.length)
            data = await attachXcallLifecycle(this, config, results[0]);
        return [data];
    }

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
}

module.exports = XcallDetailReaders.prototype;
