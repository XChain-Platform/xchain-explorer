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

const {
    ACTION_FORMAT_PROBE,
    DEPLOY_CHUNK_DETAIL,
    DEPLOY_CONTRACT_DETAIL,
    DEPLOY_CARRIER_CONTRACT,
    DEPLOY_ASSEMBLER,
    EXECUTE_DETAIL,
    EXECUTE_EMISSIONS,
    depositWithdrawDetail
} = require('../db/action_detail/contracts_sql');

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
        let fmtRows = await db.doQuery(config, ACTION_FORMAT_PROBE, [action_index]);
        let actionFormat = (fmtRows && fmtRows.length) ? Number(fmtRows[0].action_format) : null;
        if(actionFormat === 4){
            query = DEPLOY_CHUNK_DETAIL;
        } else {
            query = DEPLOY_CONTRACT_DETAIL;
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
        let rows = await db.doQuery(config, DEPLOY_CARRIER_CONTRACT, [action_index]);
        let row = (rows && rows.length) ? rows[0] : null;
        data['deployed_contract_index'] = (row) ? row.action_index : null;
        // The contract's declared identity, on the same prefix convention as
        // deployed_contract_index: present (null allowed) on every DEPLOY response, so
        // a carrier that completed nothing answers null rather than omitting the keys.
        data['contract_meta_name']    = (row) ? row.meta_name    : null;
        data['contract_meta_version'] = (row) ? row.meta_version : null;
        if(!row) return;
        data['api_version']       = row.api_version;
        data['cooldown_blocks']   = row.cooldown_blocks;
        data['slash_destination'] = row.slash_destination;
        data['contract_status']   = row.contract_status;
        // Which DEPLOY asked for this contract. NULL when this action was itself the
        // assembler, which cannot happen on a format-4 carrier, so a null here means the
        // constructor row is gone rather than that the deploy was inline.
        let exec = await db.doQuery(config, DEPLOY_ASSEMBLER, [action_index]);
        data['assembler_action_index'] = (exec && exec.length) ? exec[0].assembler_action_index : null;
    },
};

const EXECUTE = {
    // EXECUTE action (contract method call → contract_executions)
    //
    // The called contract's declared identity (contract_meta_name /
    // contract_meta_version) rides the payload so an EXECUTE reads
    // "Escrow v1.0.0 · C:BTC:2154" instead of a bare index. LEFT JOIN, and null for
    // a contract deployed before CONTRACT_META_REQUIRED: an execution row must not
    // disappear because the contract it called declared no name.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = EXECUTE_DETAIL;
        return { query, query2, query3 };
    },
    // EXECUTE: attach the actions this contract call emitted (emit.execute / emit.send /
    // internal SLASH etc.), ordered by emission position. Children link by action_index
    // (NULL for internal emissions that move ledger state without minting an on-wire
    // action, e.g. SLASH). Browsing children needs contract_emissions (actions.source_id
    // is the emitting contract address, not a parent→child pointer.
    async afterMain({ db, config, action_index }, data) {
        let emits = await db.doQuery(config, EXECUTE_EMISSIONS, [action_index]);
        data['emissions'] = (emits && emits.length) ? emits : [];
    },
};

const DEPOSIT_WITHDRAW = {
    // DEPOSIT / WITHDRAW action (contract custody transfers)
    //
    // Carries the custody counterparty's declared identity for the same reason
    // EXECUTE does: the action names the contract it moved value to or from, and a
    // name beside that index is the whole point of the manifest.
    queries({ type }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        let custodyTable = (type=='DEPOSIT') ? 'deposits' : 'withdrawals';
        query = depositWithdrawDetail(custodyTable);
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
