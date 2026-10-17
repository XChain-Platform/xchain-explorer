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
 * XChain Explorer - filter predicates for explorer paging boundaries
 *
 * Resolves interned address and token ids onto the indexed columns used by
 * each action-list boundary query.
 *
 ********************************************************************/

'use strict';

const { TWO_PARTY_ADDRESS_METHODS, TWO_PARTY_BOUNDARY_SQL, placeholderCount } = require('./where_source_lanes.js');

function addressBoundaryWhere(method, id){
    let where     = '';
    let whereArgs = [];
    if(method=='getOrderMatches'){
        where = ` AND m.action_index IN (
            SELECT om.action_index
            FROM orders o
            INNER JOIN order_matches om ON (om.give_action_index=o.action_index)
            WHERE o.get_address_id=?
            UNION
            SELECT om.action_index
            FROM orders o
            INNER JOIN order_matches om ON (om.get_action_index=o.action_index)
            WHERE o.get_address_id=?
        )`;
        whereArgs.push(id, id);
    } else if(method=='getSwapMatches'){
        where = ` AND m.action_index IN (
            SELECT sm.action_index
            FROM swaps s
            INNER JOIN swap_matches sm ON (sm.give_action_index=s.action_index)
            WHERE s.get_address_id=?
            UNION
            SELECT sm.action_index
            FROM swaps s
            INNER JOIN swap_matches sm ON (sm.get_action_index=s.action_index)
            WHERE s.get_address_id=?
        )`;
        whereArgs.push(id, id);
    } else if(TWO_PARTY_ADDRESS_METHODS.has(method)){
        // The list's own two-party id set, so the feed opens at the newest
        // action either party took part in, for every method the list serves
        // that way.
        where = TWO_PARTY_BOUNDARY_SQL[method];
        whereArgs.push(...new Array(placeholderCount(where)).fill(id));
    } else if(['getTokens'].includes(method)){
        where = ` AND m.owner_id=?`;
        whereArgs.push(id);
    } else if(method=='getCoinpayObligations'){
        where = ` AND (m.payer_address_id=? OR m.payee_address_id=?)`;
        whereArgs.push(id, id);
    } else if(['getCredits','getDebits','getEscrows'].includes(method)){
        where = ` AND m.address_id=?`;
        whereArgs.push(id);
    } else if(['getHistory'].includes(method)){
        where = ` AND m.type_id=2 AND m.id=?`;
        whereArgs.push(id);
    } else {
        // Match the action's source fallback used by every corresponding row query,
        // as the same row set as COALESCE(a1.source_id, t1.source_id)=id in the
        // form the source_id index on actions can serve.
        where = ` AND (a1.source_id=? OR (a1.source_id IS NULL AND t1.source_id=?))`;
        whereArgs.push(id, id);
    }
    return { where, whereArgs };
}

function tokenBoundaryWhere(method, id){
    let where     = '';
    let whereArgs = [];
    if(method=='getOrderMatches'){
        where = ` AND m.action_index IN (
            SELECT action_index FROM order_matches WHERE give_tick_id=?
            UNION
            SELECT action_index FROM order_matches WHERE get_tick_id=?
        )`;
        whereArgs.push(id, id);
    } else if(method=='getSwapMatches'){
        where = ` AND m.action_index IN (
            SELECT action_index FROM swap_matches WHERE give_tick_id=?
            UNION
            SELECT action_index FROM swap_matches WHERE get_tick_id=?
        )`;
        whereArgs.push(id, id);
    } else if(method=='getLinks'){
        where = ` AND m.action_index IN (
            SELECT action_index FROM links WHERE coin1_id=?
            UNION
            SELECT action_index FROM links WHERE coin2_id=?
        )`;
        whereArgs.push(id, id);
    } else if(['getOrders','getSwaps'].includes(method)){
        where = ` AND (m.get_tick_id=? OR m.give_tick_id=?)`;
        whereArgs.push(id, id);
    } else if(['getDispensers','getDispenses'].includes(method)){
        where = ` AND m.get_tick_id=?`;
        whereArgs.push(id);
    } else if(['getHistory','getFiles'].includes(method)){
        where = ` AND m.type_id=1 AND m.id=?`;
        whereArgs.push(id);
    } else {
        where = ` AND m.tick_id=?`;
        whereArgs.push(id);
    }
    return { where, whereArgs };
}

module.exports = { addressBoundaryWhere, tokenBoundaryWhere };
