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
 * XChain Explorer - single-action supplements, fee and type
 *
 * The per-index legs getActionData (in the entry) runs after its handler:
 * the sibling-table supplements, the fee row, and the action type lookup.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// ISSUE v6 controller bind/unbind fields, which live in token_controllers rather
// than in the issues row the handler selected.
async function attachIssueControllerFields(db, config, action_index, data, fmt){
    // ISSUE v6 = controller bind/unbind (ISSUE|6|TICK|CONTROLLER|ACTION_CLASS|
    // COOLDOWN_BLOCKS|UNBIND). The event row is written to token_controllers,
    // never to `issues`, so without this the four wire fields vanished from
    // the API row while /api/controllers showed them.
    data.controller      = null;
    data.action_class    = null;
    data.cooldown_blocks = null;
    data.unbind          = null;
    if(fmt === 6){
        let rows = await db.doQuery(config,
            `SELECT
                        c.contract_index as controller,
                        c.action_class,
                        c.cooldown_blocks,
                        c.is_unbind as unbind
                    FROM
                        token_controllers c
                    WHERE
                        c.action_index=?
                    LIMIT 1`, [action_index]);
        // No row = the bind/unbind never applied (invalid action, or rolled
        // back); the keys stay null rather than being reparsed from tx_data.
        if(rows && rows.length)
            Object.assign(data, rows[0]);
    }
}

// The DEPLOY v4 code slice this carrier action shipped.
async function attachDeployChunkFields(db, config, action_index, data){
    // v4 chunk carrier: CODE_PART is a first-class wire field and this page
    // is the only surface that can show the payload. The full slice rides
    // the single-action row only; list rows carry code_part_length instead
    // (getDeployChunks), because a MEDIUMTEXT slice per row is too heavy for
    // a paged list.
    data.code_part        = null;
    data.code_part_length = null;
    let rows = await db.doQuery(config,
        `SELECT
                    m.code_part,
                    CHAR_LENGTH(m.code_part) as code_part_length
                FROM
                    deploy_chunks m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
    if(rows && rows.length){
        data.code_part        = rows[0].code_part;
        data.code_part_length = db.util.isNull(rows[0].code_part_length) ? null : Number(rows[0].code_part_length);
    }
}

// The constructor run billed to a deploy: gas plus the execution linkage, read
// from the contract_executions row sitting at this same action_index.
async function attachDeployExecutionFields(db, config, action_index, data){
    // v0-v3 deploy, and the completing v4 carrier: the constructor run is
    // billed like any EXECUTE and the indexer records it in
    // contract_executions, but the detail row showed no gas at all, hiding
    // the deployer's cost. Surface the recorded gas plus the execution
    // linkage (contract_index / method_name); this reads existing execution
    // rows only and invents no fee artifacts.
    data.contract_index = null;
    data.method_name    = null;
    data.gas_used       = null;
    data.gas_limit      = null;
    let rows = await db.doQuery(config,
        `SELECT
                    m.contract_index,
                    m.method_name,
                    m.gas_used,
                    m.gas_limit
                FROM
                    contract_executions m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
    if(rows && rows.length)
        Object.assign(data, rows[0]);
}

// Which action emitted this one, for EVERY action type.
async function attachEmissionProvenance(db, config, action_index, data, pre){
    // Emission provenance, for EVERY action type. A VM-emitted action has no wire string
    // of its own - it was never on the wire - so `tx_data` on its detail row is the PARENT
    // EXECUTE's string. Read alone on a per-action page that says "Transaction Data", it
    // reads as this action's own data, and it is the field this campaign cross-checks
    // rendered values against. No synthetic string is composed here: inventing a wire form
    // that was never broadcast would be worse than the ambiguity. Instead the page is told
    // where the action came from, so it can label the parent's string as the parent's.
    // A page-level prefetch resolves this leg for the whole index set at once; asking
    // per-action here put the page back above the per-index query ceiling that
    // action-preload-parity guards. The single-index path falls through to the batch
    // helper with a set of one, so both paths return the identical shape.
    data.emitted_by = null;
    let key = Number(action_index);
    if(pre && pre.emitted && pre.indexes && pre.indexes.has(key)){
        data.emitted_by = pre.emitted.has(key) ? pre.emitted.get(key) : null;
    } else {
        let one = await db.getEmissionProvenanceBatch(config, [key]);
        data.emitted_by = one.has(key) ? one.get(key) : null;
    }
}

class ActionDataReaders {
    // Wire-carried fields the per-type detail handlers cannot select because they
    // live in a SIBLING event table, not the handler's primary table. The action
    // detail is the page that exists to render what the wire format carried, so a
    // field the indexer stores must appear here, populated on the variant that
    // carries it and present-as-null on the others (the shape every other ISSUE
    // variant field already follows). All three source tables are append-only and
    // reorg rollback deletes their rows, so the values are as cache-safe as the
    // rest of the action payload.
    async attachActionDetailSupplements(config, type, action_index, data, pre){
        let fmt = this.util.isNull(data.action_format) ? null : Number(data.action_format);
        if(type=='ISSUE')
            await attachIssueControllerFields(this, config, action_index, data, fmt);
        if(type=='DEPLOY' && fmt === 4)
            await attachDeployChunkFields(this, config, action_index, data);
        // A v4 carrier is normally a code slice and nothing else, but the piece that
        // COMPLETES a chunked group runs the deployment at its own action_index, so
        // the constructor was billed here and its execution row sits at this index
        // too. The detail handler's own probe has already answered whether a
        // contracts row exists here (deployed_contract_index, set in afterMain,
        // which runs before this method), so this reuses that answer rather than
        // asking again: an ordinary carrier that completed nothing still issues no
        // contract_executions query at all.
        let carrierDeployed = (fmt === 4 && !this.util.isNull(data.deployed_contract_index));
        if(type=='DEPLOY' && fmt !== null && (fmt !== 4 || carrierDeployed))
            await attachDeployExecutionFields(this, config, action_index, data);
        await attachEmissionProvenance(this, config, action_index, data, pre);
    }

    // Get fee information for a given action_index
    async getActionFeeData(config, action_index){
        let fee   = null;
        let args  = [action_index];
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }

    async getActionType(config, action_index){
        let type = null;
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        LEFT  JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(config, sql, args);
        if(results && results.length)
            type = results[0].action;
        return type;
    }
}

module.exports = ActionDataReaders.prototype;
