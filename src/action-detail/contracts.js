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
    //
    // Since deferred assembly, neither format's own row is the whole story. A chunked
    // group deploys at whichever piece completes it, so an assembler's contract can live
    // at a LATER action and a carrier's page can be where a contract was created:
    //   v0-v3  deployed_contract_index / assembly_status, resolved in the query below
    //   v4     deployed_contract_index + the deploy card, probed in afterMain
    // deployed_contract_index is the field the SDK and the wallet poll to learn where
    // their contract landed, so it is present (null allowed) on every DEPLOY response.
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
        }
        return { query, query2, query3 };
    },
    // A chunk carrier can be the action a contract was deployed AT: whichever piece
    // completes the group runs the deployment, and everything it writes is keyed at that
    // piece's action_index. Without this probe the carrier's page shows only its own base64
    // slice and the contract is unreachable from the action that created it.
    //
    // A carrier that completed nothing (the normal case) has no contracts row at its index,
    // which is exactly the null answer; the carrier query above is left as it is so the
    // ordinary carrier still costs one point read on an indexed key. The execution row that
    // names the assembler is a SECOND read, deliberately reached only once a contract is
    // known to be here: a chunk that deployed nothing has no constructor to describe.
    async afterMain({ db, config, action_index }, data) {
        if(Number(data.action_format) !== 4) return;
        let rows = await db.doQuery(config,
            `SELECT
                c1.action_index,
                c1.api_version,
                c1.cooldown_blocks,
                sd1.address as slash_destination,
                cs1.status as contract_status
             FROM
                contracts c1
                LEFT JOIN index_addresses sd1 ON (sd1.id=c1.slash_destination_id)
                LEFT JOIN index_statuses  cs1 ON (cs1.id=c1.status_id)
             WHERE
                c1.action_index=?
             LIMIT 1`, [action_index]);
        let row = (rows && rows.length) ? rows[0] : null;
        data['deployed_contract_index'] = (row) ? row.action_index : null;
        if(!row) return;
        data['api_version']       = row.api_version;
        data['cooldown_blocks']   = row.cooldown_blocks;
        data['slash_destination'] = row.slash_destination;
        data['contract_status']   = row.contract_status;
        // Which DEPLOY asked for this contract. NULL when this action was itself the
        // assembler, which cannot happen on a format-4 carrier, so a null here means the
        // constructor row is gone rather than that the deploy was inline.
        let exec = await db.doQuery(config,
            `SELECT
                e1.assembler_action_index
             FROM
                contract_executions e1
             WHERE
                e1.action_index=?
             LIMIT 1`, [action_index]);
        data['assembler_action_index'] = (exec && exec.length) ? exec[0].assembler_action_index : null;
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
