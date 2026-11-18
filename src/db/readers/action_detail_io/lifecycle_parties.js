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
 * XChain Explorer - lifecycle parties for the live feed
 *
 * Names the parties of the actions the indexer mints itself (matches and expiry
 * passes), which carry no source and no destination rows. A party is the address
 * that placed the order, swap, dispenser or bet feed the action settled, read
 * through that parent row, or the payer and payee of an expired coin payment.
 * Ledger rows are deliberately not used: a royalty or fee leg is credited without
 * being a party, and a coin-pay match or a parked expiry writes none.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time.
 *
 ********************************************************************/

'use strict';

// action type -> the joins that reach its parties. Each join starts from the
// action's own lifecycle row `m` (keyed by m.action_index) and must end on an
// index_addresses row aliased `a2`. Compile-time literals only; every value is bound.
function parentPlacer(table, column, parent) {
    return `${table} m
                INNER JOIN ${parent} p ON (p.action_index=m.${column})
                INNER JOIN actions a1 ON (a1.action_index=p.action_index)
                INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)`;
}

function obligationParty(column) {
    return `coinpay_expires m
                INNER JOIN coinpay_obligations o ON (o.action_index=m.obligation_action_index)
                INNER JOIN index_addresses a2 ON (a2.id=o.${column})`;
}

const PARTY_JOINS = {
    ORDER_MATCH:      [parentPlacer('order_matches', 'give_action_index', 'orders'),
                       parentPlacer('order_matches', 'get_action_index', 'orders')],
    SWAP_MATCH:       [parentPlacer('swap_matches', 'give_action_index', 'swaps'),
                       parentPlacer('swap_matches', 'get_action_index', 'swaps')],
    ORDER_EXPIRE:     [parentPlacer('order_expires', 'order_action_index', 'orders')],
    SWAP_EXPIRE:      [parentPlacer('swap_expires', 'swap_action_index', 'swaps')],
    DISPENSER_EXPIRE: [parentPlacer('dispenser_expires', 'dispenser_action_index', 'dispensers')],
    DISPENSER_CLOSE:  [parentPlacer('dispenser_closes', 'dispenser_action_index', 'dispensers')],
    COINPAY_EXPIRE:   [obligationParty('payer_address_id'), obligationParty('payee_address_id')],
    // The feed's creator only: the refunded bettors are unbounded in number, and
    // their balance changes already reach them as ADDRESS_UPDATE from the ledger.
    BET_EXPIRE:       [parentPlacer('bet_feed_statuses', 'feed_action_index', 'bet_feeds')]
};

class LifecyclePartyReaders {
    // action_index (as a decimal string) -> Set of party addresses, for the actions
    // of a getActionsSince batch whose type has parties above. Every such action has
    // a key, with an empty Set when no party row resolves, and no other action has
    // one. One UNION round trip covering the whole batch, no query when the batch has
    // no such action, and a failed read throws for the caller to degrade.
    async getLifecycleParties(config, actions){
        let map = new Map();
        let byType = new Map();
        for(let action of (actions || [])){
            if(!action || !PARTY_JOINS[action.action] || this.util.isNull(action.action_index)) continue;
            if(!byType.has(action.action)) byType.set(action.action, []);
            byType.get(action.action).push(action.action_index);
            map.set(String(action.action_index), new Set());
        }
        if(!byType.size) return map;

        let parts = [];
        let args  = [];
        for(let [type, indexes] of byType){
            let holes = indexes.map(() => '?').join(',');
            for(let join of PARTY_JOINS[type]){
                parts.push(`SELECT m.action_index as action_index, a2.address as address
                            FROM ${join}
                            WHERE m.action_index IN (${holes})`);
                args.push(...indexes);
            }
        }
        let rows = await this.doQuery(config, parts.join(' UNION '), args);
        for(let row of (rows || [])){
            if(!row || this.util.isNull(row.action_index) || this.util.isNull(row.address)) continue;
            let parties = map.get(String(row.action_index));
            if(parties) parties.add(String(row.address));
        }
        return map;
    }
}

module.exports = LifecyclePartyReaders.prototype;
