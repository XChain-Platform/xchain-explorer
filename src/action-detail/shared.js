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
 * Shaping steps shared by more than one action handler.
 *
 * ORDER, SWAP and DISPENSER all publish a live `state` block derived from rows
 * written AFTER the action confirmed, and all three read their list edits the
 * same way, so both steps live here instead of being duplicated per family.
 ********************************************************************/

'use strict';

// Create an state object with current state info
async function applyOfferState({ db, config, action_index, type }, data) {
    data['state'] = {
        get_remaining:  data['get_amount'],
        give_remaining: data['give_amount'],
        expiration:     data['expiration'],
        allow_list:     data['allow_list'],
        block_list:     data['block_list'],
        status:         data['current_status']
    }
    delete data['current_status'];
    if(type=='DISPENSER'){
       // : one shared derivation for both read lanes. What is left in
       // escrow is create + refills - payouts, and this path used to compute
       // it inline from its own edit/dispense queries while the list lane
       // served nothing at all.
       let escrow = await db.getDispenserEscrowBatch(config, [action_index]);
       let entry  = escrow[String(action_index)];
       data.state.give_remaining = (entry) ? entry.escrow_remaining : null;
       delete data.state.get_remaining;
    }
}

// The allow/block list edits and the expiration an ORDER / SWAP / DISPENSER has
// accumulated since it was created. Shared by all three because the rows have
// the same shape; only DISPENSER gates an edit on the activation delay.
async function applyOfferListEdits({ db, config, coinConfigs, type }, data, results) {
    // Mirror consensus when deriving DISPENSER list-edit activation: the indexer
    // gates activation on the deterministic block timestamp (block_time), never on
    // wall-clock. Comparing against the latest indexed block_time keeps activation
    // status identical across explorer hosts regardless of each host's local clock.
    let now = await db.getMaxBlockTime(config);
    for(let row of results){
        let active = true;
        if(type=='DISPENSER'){
            // Escrow is derived by getDispenserEscrowBatch above ;
            // this loop only advances the expiration / list state.
            // Determine if the allow/block list edits are active using DISPENSER_LIST_DELAY.
            // Use a bignumber comparison (matching the indexer's bcgt-based consensus check)
            // rather than a JS '>' on mixed Number/bignumber operands.
            // A row with no block_time cannot be aged, and bcadd() would read it as 0
            // (i.e. active since the epoch), so withhold it instead of leaking a list
            // edit the delay has not released yet. The query2 join guarantees a value.
            active = db.util.isNull(row.block_time)
                ? false
                : db.util.bcgt(now, db.util.bcadd(row.block_time, coinConfigs['DISPENSER_LIST_DELAY']));
        }
        if(!db.util.isNull(row.expiration))  data.state.expiration  = row.expiration;
        if(active){
            if(!db.util.isNull(row.allow_list))  data.state.allow_list  = row.allow_list;
            if(!db.util.isNull(row.block_list))  data.state.block_list  = row.block_list;
        }
    }
}

// De-blank guard. A known action whose dedicated branch matched no row
// (a system-synthesized transaction-less / row-less variant such as an
// XCALL v1 result-marker or an ATTEST v2 expire, or a mirror-injected
// XEXEC / CROSS_SETTLE whose domain row was reorg-dropped after the
// action was minted) would otherwise fall through with all-NULL data
// and render a page emptier
// than the UNKNOWN fallback. Populate the baseline action name / block /
// timestamp / source from the actions + blocks tables so every
// addressable action shows at least those. Transaction-less-safe:
// block is joined via actions.block_index (set for every action) and
// transactions is LEFT joined (NULL tx_index yields NULL tx fields, not
// a dropped row) - the same shape COINPAY_EXPIRE / ORDER_MATCH use. The
// ledger effects (credits / debits / escrows) still attach by
// action_index regardless of this branch.
async function deblankBaseline(db, config, action_index, data) {
    let genericQuery = `SELECT
                a2.action,
                a1.action_format,
                a1.action_index,
                a3.address as source,
                b1.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index
            FROM
                actions                       a1
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
            WHERE
                a1.action_index=?
            LIMIT 1`;
    let gres = await db.doQuery(config, genericQuery, [action_index]);
    return (gres && gres.length) ? Object.assign({}, data, gres[0]) : data;
}

// The ledger effects of an action: what it credited, what it debited, what it
// put in escrow. Identical for every action (they all key on action_index), so
// a handler only chooses whether each one runs, via its `effects` flags. The
// four non-ledger actions (ADDRESS, BROADCAST, XCALL, NODEPROOF) skip all three.
const EFFECT_TABLES = [
    { key: 'credits', table: 'credits c1', alias: 'c1' },
    { key: 'debits',  table: 'debits d1',  alias: 'd1' },
    { key: 'escrows', table: 'escrows e1', alias: 'e1' }
];

async function attachLedgerEffects(db, config, action_index, data, effects) {
    let flags = effects || {};
    for(let effect of EFFECT_TABLES){
        if(flags[effect.key] === false) continue;
        let a = effect.alias;
        let query = `SELECT
                    a1.address,
                    t1.tick,
                    ${a}.amount
                FROM
                    ${effect.table}
                    LEFT  JOIN index_tickers   t1 ON (t1.id=${a}.tick_id)
                    LEFT  JOIN index_addresses a1 ON (a1.id=${a}.address_id)
                WHERE
                    ${a}.action_index=?
                ORDER BY
                    t1.tick ASC,
                    CAST(${a}.amount as DECIMAL(64,18)) DESC,
                    a1.address ASC`;
        let results = await db.doQuery(config, query, [action_index]);
        if(results && results.length)
            data[effect.key] = results;
    }
}

module.exports = { applyOfferState, applyOfferListEdits, deblankBaseline, attachLedgerEffects };
