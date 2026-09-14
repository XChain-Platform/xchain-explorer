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
 * Detail handlers for the dispenser family (create / edit / close / cancel /
 * expire / dispense) and the COINPAY pair that settles against them.
 ********************************************************************/

'use strict';

const shared = require('./shared.js');
// Statement text lives under src/db/ with the rest of the explorer's SQL.
const sql = require('../db/action_detail/dispensers_sql.js');

// coin_amount/vout are the SETTLEMENT record's; when one transaction pays more
// than one obligation, each row names the specific output that paid THAT
// obligation, not the transaction's first output (mainnet not yet armed;
// testnet/regtest already this way). See "One Payment, Several Dispensers" in
// protocol/actions/dispenser.md for the get_amount analogue below.
const COINPAY = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.COINPAY_QUERY;
        return { query, query2, query3 };
    },
};

const COINPAY_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.COINPAY_EXPIRE_QUERY;
        return { query, query2, query3 };
    },
};

const DISPENSER = {
    // The dispenser as created, joined to its newest status row so the page
    // shows where it stands now rather than how it started.
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSER_QUERY;
        query2 = sql.DISPENSER_QUERY2;
        return { query, query2, query3 };
    },
    // Escrow derives as create + refills - payouts, reaching 0 only when drained.
    // An expired or cancelled dispenser had its escrow refunded by the terminal
    // action and nothing nets that out, so apply the terminal rule explicitly.
    async afterMain(ctx, data) {
        await shared.applyOfferState(ctx, data);
        shared.applyTerminalOfferState(data);
    },
    afterQuery2: shared.applyOfferListEdits,
};

const DISPENSER_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSER_CANCEL_QUERY;
        return { query, query2, query3 };
    },
};

const DISPENSER_CLOSE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSER_CLOSE_QUERY;
        return { query, query2, query3 };
    },
};

const DISPENSER_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSER_EDIT_QUERY;
        return { query, query2, query3 };
    },
};

const DISPENSER_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSER_EXPIRE_QUERY;
        return { query, query2, query3 };
    },
};

// m.get_amount is dispenses.get_amount (a fill), not d1.get_amount (the
// dispenser's price, above). When one payment fills several dispensers behind
// the same address in a batch, each fill's get_amount is its share of the
// payment rather than the whole payment restated per row (mainnet not yet
// armed; testnet/regtest already this way). See "One Payment, Several
// Dispensers" in protocol/actions/dispenser.md.
const DISPENSE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DISPENSE_QUERY;
        return { query, query2, query3 };
    },
};

module.exports = {
    COINPAY,
    COINPAY_EXPIRE,
    DISPENSER,
    DISPENSER_CANCEL,
    DISPENSER_CLOSE,
    DISPENSER_EDIT,
    DISPENSER_EXPIRE,
    DISPENSE
};
