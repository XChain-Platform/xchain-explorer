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
 * Detail handlers for the contract lifecycle: DEPLOY (chunk carrier and the
 * deploy itself), EXECUTE, and the DEPOSIT / WITHDRAW custody transfers.
 ********************************************************************/

'use strict';

const DEPLOY = {
    // DEPLOY action. The chunk carrier (v4) and the actual deploy (v0-v3) share the
    // DEPLOY action name but live in different tables, so pick the detail query by the
    // format version: v4 → deploy_chunks (one base64 code slice); v0-v3 → contracts
    // (v1 surfaces cooldown_blocks + slash_destination).
    async queries({ db, config, action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        let fmtRows = await db.doQuery(config, 'SELECT action_format FROM actions WHERE action_index=? LIMIT 1', [action_index]);
        let actionFormat = (fmtRows && fmtRows.length) ? Number(fmtRows[0].action_format) : null;
        if(actionFormat === 4){
            query = `SELECT
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
        } else {
            query = `SELECT
                        a2.action,
                        a1.action_format,
                        m.action_index,
                        a3.address as source,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
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
        }
        return { query, query2, query3 };
    },
};

const EXECUTE = {
    // EXECUTE action (contract method call → contract_executions)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // EXECUTE: attach the actions this contract call emitted (emit.execute / emit.send /
    // internal SLASH etc.), ordered by emission position. Children link by action_index
    // (NULL for internal emissions that move ledger state without minting an on-wire
    // action, e.g. SLASH). Browsing children needs contract_emissions (actions.source_id
    // is the emitting contract address, not a parent→child pointer.
    async afterMain({ db, config, action_index }, data) {
        let emits = await db.doQuery(config,
            `SELECT position, emitted_action, action_index
             FROM contract_emissions WHERE execution_index=? ORDER BY position ASC`, [action_index]);
        data['emissions'] = (emits && emits.length) ? emits : [];
    },
};

const DEPOSIT_WITHDRAW = {
    // DEPOSIT / WITHDRAW action (contract custody transfers)
    queries({ type }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        let custodyTable = (type=='DEPOSIT') ? 'deposits' : 'withdrawals';
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.contract_index,
                    a3.address as source,
                    tk.tick,
                    m.amount,
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
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

module.exports = {
    DEPLOY,
    EXECUTE,
    // One handler, two action names: DEPOSIT and WITHDRAW share a row shape.
    DEPOSIT:  DEPOSIT_WITHDRAW,
    WITHDRAW: DEPOSIT_WITHDRAW
};
