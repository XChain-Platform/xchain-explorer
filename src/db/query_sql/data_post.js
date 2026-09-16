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
 * XChain Explorer - the per-page passes getData runs over its rows
 *
 * One part of src/db/query_sql.js: the three list methods whose page carries a
 * column no single SQL statement produces. Each pass is one batched read for the
 * whole page (never a query per row) folded onto the rows in place, which is why
 * they run here rather than inside the reader: those methods return SQL, not
 * rows.
 *
 * Plain functions, not a class body: they take the Database as `db` and nothing
 * here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

const { TERMINAL_OFFER_STATUSES } = require('../../action-detail/shared.js');

// A dispenser list lane with no escrow leaves a client listing
// dispensers unable to say how full any of them is, so give_escrow
// comes back with the row and the live remainder is derived here
// through the same shared method the per-action detail path uses (one
// batched pass for the whole page, not a query per row).
async function dispenserPass(db, config, data){
    let idxs   = data.map((r) => r.action_index);
    let escrow = await db.getDispenserEscrowBatch(config, idxs);
    // The row's own `status` is the CREATE action's validity and never
    // moves off 'valid', so a listing could not tell an open dispenser
    // from a cancelled one - and the escrow arithmetic above only nets
    // out fills, so a cancelled/expired dispenser (escrow refunded by
    // the terminal action) kept listing its full balance. Serve the
    // lifecycle beside the validity under the same `current_status` key
    // the detail path uses, and apply the detail path's terminal rule.
    let status = await db.getDispenserCurrentStatusBatch(config, idxs);
    for(let row of data){
        let entry = escrow[String(row.action_index)];
        row.escrow_remaining = (entry) ? entry.escrow_remaining : null;
        row.current_status   = status[String(row.action_index)] || null;
        if(TERMINAL_OFFER_STATUSES.includes(String(row.current_status)))
            row.escrow_remaining = '0';
    }
}

// Contract list rows carry the same identity shape the single-contract route
// serves: three flat meta_* columns plus the parsed `meta` object. Done here
// rather than in getContracts because that method returns SQL, not rows.
function contractPass(db, data){
    for(let row of data)
        db.attachContractMeta(row);
}

// /validators stays the ONE validator table (no second federation-registry
// page), so every on-chain active-set row also carries the hub registry's view of
// the same signing pubkey: network addr, served chains, registration status. One
// registry read serves the whole page, not a lookup per row. A pubkey the hub does
// not list is 'unregistered'; a deployment with no reachable hub registry leaves
// all three null, which the page renders as unknown rather than as unregistered.
async function validatorPass(db, config, data){
    let registry = await db.getFederationRegistry(config);
    for(let row of data){
        let entry = (registry && !db.util.isNull(row.signing_pubkey))
            ? registry[String(row.signing_pubkey).toLowerCase()]
            : null;
        row.hub_addr   = (entry) ? entry.addr   : null;
        row.hub_chains = (entry) ? entry.chains : null;
        row.hub_status = (entry) ? entry.status : (registry ? 'unregistered' : null);
    }
}

// Runs whichever pass this method's page needs, in the order getData ran them.
// A page of no rows takes none of them: every pass reads the whole page in one
// batched query, which there is nothing to build a batch from.
async function applyPostPasses(db, config, data){
    if(!Array.isArray(data) || !data.length)
        return data;
    let method = config.data.method;
    if(method=='getDispensers')
        await dispenserPass(db, config, data);
    if(method=='getContracts')
        contractPass(db, data);
    if(method=='getValidators')
        await validatorPass(db, config, data);
    return data;
}

module.exports = { dispenserPass, contractPass, validatorPass, applyPostPasses };
