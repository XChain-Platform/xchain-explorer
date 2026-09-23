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
const bridgeSql = require('../db/action_detail/xbridge_sql.js');
const { tablesPresent, setTablesAbsent, isMissingTableError,
        columnsPresent, setColumnsAbsent, isUnknownColumnError } = require('../db/schema_probe.js');

// Read every leg of a multi-leg SEND or DESTROY, in wire order when the connected
// replica records leg_ordinal. A replica without it takes the unsorted read, which
// is exactly what every replica got before the column existed.
async function readLegs({ db, config, action_index }, table, legsQuery){
    const columns = [sql.LEG_ORDINAL_COLUMN];
    const ordered = await columnsPresent(db, config, table, columns);
    try {
        return await db.doQuery(config, legsQuery(ordered), [action_index]);
    } catch(e) {
        // The net under a probe that answered wrong: record the real shape, read unsorted.
        if(!ordered || !isUnknownColumnError(e)) throw e;
        setColumnsAbsent(db, config, table, columns);
        return db.doQuery(config, legsQuery(false), [action_index]);
    }
}

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
        return { query, query2, query3 };
    },
    // Attach every burn leg; the leg read is probe-guarded, so it runs here rather
    // than in the static query2 slot.
    async afterMain(ctx, data) {
        const legs = await readLegs(ctx, 'destroys', sql.destroyLegsQuery);
        if(legs && legs.length) data.destroys = legs;
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
        return { query, query2, query3 };
    },
    // Add any SENDS to the send data, so a send to several recipients lists
    // every one of them in the order it was broadcast
    async afterMain(ctx, data) {
        const legs = await readLegs(ctx, 'sends', sql.sendLegsQuery);
        if(legs && legs.length) data.sends = legs;
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
// BTC, v2/v5 the mirror-injected settle). The baseline row (action, format,
// source, block, tx) comes from getActionData's de-blank fallback and this
// handler attaches the bridge context that is knowable on THIS chain:
//
//   - a user leg's own facts are its `xbridges` row, written at parse time on the
//     chain it was broadcast from: destination chain and address, the decimals and
//     minimum depth stamped at its block, its memo and its verdict. An injected
//     leg writes no such row;
//   - an injected leg is keyed by its OWN action_index in bridge_settlements,
//     the table the settle pass writes, so v2/v5 resolve their transfer_id,
//     kind, the source leg they close and the destination they credited;
//   - a user leg's settlement is applied on the OTHER chain (a BTC lock settles
//     on DOGE, a DOGE burn settles on BTC), so this chain holds no settlement
//     row for it and `bridge_settlement` is null until the far leg lands. That
//     null is the in-flight state, not a missing record, which is why it is
//     reported as an explicit `bridge_pending` flag rather than left blank;
//   - a replica that has not taken the indexer's bridge-tables migration holds
//     neither table, so this node knows NOTHING about the leg. Every key above is
//     then omitted rather than nulled: absence reads as unknown, while
//     `bridge_pending: true` would tell a holder their transfer is in flight on
//     the strength of a table that was never read.
//
// The amount moved is not re-read here: the shared ledger-effect step already
// attaches the credits and debits (the escrow credit on a lock, the escrow debit
// on an out-leg), which is the same ledger the consensus rule wrote.

// The xbridges columns a user leg's detail card reads.
const XBRIDGE_RECORD_KEYS = ['dest_chain', 'dest_address', 'decimals', 'min_depth', 'memo', 'status'];

// Read one bridge table only when the connected schema carries it: on a replica that
// never took the bridge migration the statement is error 1146 for the whole action
// page, and the page is worth more than the section. Answers null when nothing was read.
async function readBridgeTable({ db, config, action_index }, table, statement){
    if(!await tablesPresent(db, config, [table])) return null;
    try {
        return await db.doQuery(config, statement, [action_index]);
    } catch(e) {
        // The net under a probe that answered wrong (it failed, or the table went
        // away under a live explorer). A failure that is not a missing table is a
        // real query failure and stays the caller's to handle.
        if(!isMissingTableError(e)) throw e;
        setTablesAbsent(db, config, [table]);
        return null;
    }
}

// Lift a user leg's own record to the top level; never overwrite a tick the baseline resolved.
function attachXbridgeRecord(data, rows){
    const row = (rows && rows.length) ? rows[0] : null;
    if(!row) return;
    for(const key of XBRIDGE_RECORD_KEYS)
        data[key] = row[key];
    data['tick'] = data['tick'] || row.tick || null;
}

// Lift the settle row's identifying fields so the card reads one shape whether the
// leg was injected or broadcast; no row on a read table is the in-flight state.
function attachXbridgeSettlement(data, settle){
    let row = (settle && settle.length) ? settle[0] : null;
    data['bridge_settlement'] = row;
    data['transfer_id']   = (row) ? row.transfer_id : null;
    data['bridge_kind']   = (row) ? row.kind        : null;
    data['tick']          = (row) ? row.tick        : (data['tick'] || null);
    data['bridge_pending'] = (row) ? false : true;
}

const XBRIDGE = {
    // No static detail query: both bridge reads are probe-guarded, so they run in
    // afterMain, and the de-blank baseline is the main row.
    queries() {
        return { query: null, query2: null, query3: null };
    },
    async afterMain(ctx, data) {
        attachXbridgeRecord(data, await readBridgeTable(ctx, bridgeSql.XBRIDGES_TABLE, bridgeSql.XBRIDGE_RECORD));
        const settle = await readBridgeTable(ctx, bridgeSql.BRIDGE_SETTLEMENTS_TABLE, bridgeSql.XBRIDGE_SETTLEMENT);
        if(settle !== null) attachXbridgeSettlement(data, settle);
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
