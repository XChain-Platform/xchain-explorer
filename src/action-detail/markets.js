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
 * Detail handlers for the on-chain markets: ORDER and SWAP, each with their
 * cancel / edit / expire / match legs.
 ********************************************************************/

'use strict';

const shared = require('./shared.js');
const orderSql = require('../db/action_detail/orders_sql.js');
const swapSql = require('../db/action_detail/swaps_sql.js');

const ORDER = {
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = orderSql.ORDER_DETAIL;
        // Order edits come back as query2; afterQuery2 applies them oldest first
        // so the latest expiration and allow/block lists win.
        query2 = orderSql.ORDER_EDITS;
        // Order fills come back as query3; afterQuery3 subtracts each one from
        // the order's amounts to get what is still unfilled.
        query3 = orderSql.ORDER_MATCHES;
        return { query, query2, query3 };
    },
    // Zero here AND after the fills subtraction: the registry skips afterQuery3
    // when query3 returns no rows, which is exactly the unfilled-expiry case. Safe
    // twice because afterQuery3 recomputes from give_amount, not from state.
    async afterMain(ctx, data) {
        await shared.applyOfferState(ctx, data);
        shared.applyTerminalOfferState(data);
    },
    afterQuery2: shared.applyOfferListEdits,
    // query3 matches this order on either leg, so its action_index is bound twice.
    query3Args({ action_index }) {
        return [action_index, action_index];
    },
    afterQuery3({ db, action_index }, data, results) {
        let give_remaining = data['give_amount'],
            get_remaining  = data['get_amount'];
        for(let row of results){
            let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
            let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
            give_remaining  = db.util.bcsub(give_remaining, give_amount);
            get_remaining   = db.util.bcsub(get_remaining,  get_amount);
        }
        data.state.give_remaining = String(give_remaining);
        data.state.get_remaining  = String(get_remaining);
        // A partially-filled order that then expired still has escrow released,
        // so the unfilled residue is not on offer either.
        shared.applyTerminalOfferState(data);
    },
};

const ORDER_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = orderSql.ORDER_CANCEL_DETAIL;
        return { query, query2, query3 };
    },
};

const ORDER_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = orderSql.ORDER_EDIT_DETAIL;
        return { query, query2, query3 };
    },
};

const ORDER_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = orderSql.ORDER_EXPIRE_DETAIL;
        return { query, query2, query3 };
    },
};

const ORDER_MATCH = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = orderSql.ORDER_MATCH_DETAIL;
        return { query, query2, query3 };
    },
};

const SWAP = {
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = swapSql.SWAP_DETAIL;
        // Swap edits come back as query2; afterQuery2 applies them oldest first
        // so the latest expiration and allow/block lists win.
        query2 = swapSql.SWAP_EDITS;
        return { query, query2, query3 };
    },
    // ORDER corrects the seeded remaining from order_matches; a swap has no fills
    // table to subtract (cross_settle writes no swap_matches row, cancel/expire
    // write none), so its escrow-gone signal is the terminal status alone.
    async afterMain(ctx, data) {
        await shared.applyOfferState(ctx, data);
        shared.applyTerminalOfferState(data);
    },
    afterQuery2: shared.applyOfferListEdits,
};

const SWAP_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = swapSql.SWAP_CANCEL_DETAIL;
        return { query, query2, query3 };
    },
};

const SWAP_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = swapSql.SWAP_EDIT_DETAIL;
        return { query, query2, query3 };
    },
};

const SWAP_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = swapSql.SWAP_EXPIRE_DETAIL;
        return { query, query2, query3 };
    },
};

const SWAP_MATCH = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = swapSql.SWAP_MATCH_DETAIL;
        return { query, query2, query3 };
    },
};

module.exports = {
    ORDER,
    ORDER_CANCEL,
    ORDER_EDIT,
    ORDER_EXPIRE,
    ORDER_MATCH,
    SWAP,
    SWAP_CANCEL,
    SWAP_EDIT,
    SWAP_EXPIRE,
    SWAP_MATCH
};
