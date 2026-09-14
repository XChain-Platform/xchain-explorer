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
 * Detail handlers for the token-supply and transfer actions: AIRDROP, DESTROY,
 * DIVIDEND, ISSUE, LINK, MINT, SEND and SWEEP.
 ********************************************************************/

'use strict';

// Statement text lives under src/db/ with the rest of the explorer's SQL.
const sql = require('../db/action_detail/tokens_sql.js');

const AIRDROP = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.AIRDROP_QUERY;
        query2 = sql.AIRDROP_QUERY2;
        return { query, query2, query3 };
    },
    afterQuery2(ctx, data, results) {
        data.airdrops = results;
    },
};

const DESTROY = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DESTROY_QUERY;
        query2 = sql.DESTROY_QUERY2;
        return { query, query2, query3 };
    },
    afterQuery2(ctx, data, results) {
        data.destroys = results;
    },
};

const DIVIDEND = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.DIVIDEND_QUERY;
        return { query, query2, query3 };
    },
};

const ISSUE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.ISSUE_QUERY;
        return { query, query2, query3 };
    },
};

const LINK = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.LINK_QUERY;
        return { query, query2, query3 };
    },
};

const MINT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.MINT_QUERY;
        return { query, query2, query3 };
    },
};

const SEND = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.SEND_QUERY;
        query2 = sql.SEND_QUERY2;
        return { query, query2, query3 };
    },
    // Add any SENDS to the send data, so a send to several recipients lists
    // every one of them
    afterQuery2(ctx, data, results) {
        data.sends = results;
    },
};

const SWEEP = {
    // A sweep moves an address's holdings to one destination. Balances,
    // ownerships, orders, swaps and dispensers are separate flags, so each
    // kind can be swept on its own.
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.SWEEP_QUERY;
        query2 = sql.SWEEP_QUERY2;
        return { query, query2, query3 };
    },
    // Add any ISSUES to the sweep data: token ownership a sweep hands over is
    // recorded as issue rows under the sweep's own action
    afterQuery2(ctx, data, results) {
        data.issues = results;
    },
};

// XBRIDGE action (the cross-chain bridge leg: v0/v3 lock on BTC, v1/v4 burn off
// BTC, v2/v5 the mirror-injected settle). There is no bespoke wire table for the
// user-broadcast legs, so the baseline row (action, format, source, block, tx)
// comes from getActionData's de-blank fallback and this handler only attaches
// the bridge context that is knowable on THIS chain:
//
//   - an injected leg is keyed by its OWN action_index in bridge_settlements,
//     the table the settle pass writes, so v2/v5 resolve their transfer_id,
//     kind, the source leg they close and the destination they credited;
//   - a user leg's settlement is applied on the OTHER chain (a BTC lock settles
//     on DOGE, a DOGE burn settles on BTC), so this chain holds no settlement
//     row for it and `bridge_settlement` is null until the far leg lands. That
//     null is the in-flight state, not a missing record, which is why it is
//     reported as an explicit `bridge_pending` flag rather than left blank.
//
// The amount moved is not re-read here: the shared ledger-effect step already
// attaches the credits and debits (the escrow credit on a lock, the escrow debit
// on an out-leg), which is the same ledger the consensus rule wrote.
const XBRIDGE = {
    // No detail table of its own; the de-blank baseline is the main row.
    queries() {
        return { query: null, query2: null, query3: null };
    },
    async afterMain({ db, config, action_index }, data) {
        let settle = await db.doQuery(config, sql.XBRIDGE_SETTLEMENT, [action_index]);
        let row = (settle && settle.length) ? settle[0] : null;
        data['bridge_settlement'] = row;
        // Lift the identifying fields to the top level so the detail card reads
        // one shape whether the leg was injected or broadcast.
        data['transfer_id']   = (row) ? row.transfer_id : null;
        data['bridge_kind']   = (row) ? row.kind        : null;
        data['tick']          = (row) ? row.tick        : (data['tick'] || null);
        data['bridge_pending'] = (row) ? false : true;
    },
};

module.exports = {
    AIRDROP,
    DESTROY,
    DIVIDEND,
    ISSUE,
    LINK,
    MINT,
    SEND,
    SWEEP,
    XBRIDGE
};
