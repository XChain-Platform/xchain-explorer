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
 * Detail handlers for the structural / non-ledger actions: ADDRESS options,
 * BATCH containers, BROADCAST, CALLBACK, FILE, MESSAGE, SLEEP, LIST membership
 * and the UNKNOWN catch-all.
 ********************************************************************/

'use strict';

// Statement text lives under src/db/ with the rest of the explorer's SQL.
const sql = require('../db/action_detail/misc_sql.js');

const ADDRESS = {
    effects: { credits: false, debits: false, escrows: false },
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.ADDRESS_QUERY;
        query2 = sql.ADDRESS_QUERY2;
        return { query, query2, query3 };
    },
    // Name the fields for the reader of an action page: `controller` is the guard contract's
    // action_index, `unbind` mirrors the wire field, and the cooldown pair is what a later drop costs.
    afterQuery2({ util }, data, results) {
        let row = results[0];
        data.action_class       = row.action_class;
        data.controller         = (util.isNull(row.contract_index)) ? null : Number(row.contract_index);
        data.unbind             = (Number(row.is_unbind) === 1) ? 1 : 0;
        data.cooldown_blocks    = (util.isNull(row.cooldown_blocks)) ? null : Number(row.cooldown_blocks);
        data.cooldown_end_block = (util.isNull(row.cooldown_end_block)) ? null : Number(row.cooldown_end_block);
    },
};

const BATCH = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.BATCH_QUERY;
        query2 = sql.BATCH_QUERY2;
        return { query, query2, query3 };
    },
    // A batch renders each member action exactly as its own page would, so the
    // children are fetched by recursing into getActionData. query2 is keyed by
    // the batch's transaction, hence the second argument.
    query2Args({ action_index }, data) {
        return [action_index, data.tx_index];
    },
    // Resolve the children through the batch loader rather than one serial await each.
    // A serial recursion paid ~6-8 round trips per child with no shared-leg preload, so a
    // cold max-size batch (BATCH_ISSUANCE_LIMITS caps sub-commands at 250) issued well over
    // a thousand strictly sequential queries on a user-reachable page. getActionDataBatch
    // resolves the same indexes through the SAME unmodified getActionData, bounded by
    // BATCH_CONCURRENCY, so every child payload is unchanged and the pool cannot be drained.
    // Order comes from the index list, never from the returned Map (query2 is ordered by
    // action_index and the column is unique, so the mapping is one-to-one).
    // BATCH cannot nest (actionLimits['BATCH'] = 0), so the fan-out is one level deep.
    async afterQuery2({ db, config }, data, results) {
        let indexes  = results.map((row) => Number(row.action_index));
        let byIndex  = await db.getActionDataBatch(config, indexes);
        data.actions = indexes.map((idx) => byIndex.get(idx));
        // Stamp the same compact summary the transaction/history rows carry, so the
        // member table renders through one projection instead of reading the full
        // payload flat (a SEND keeps tick/amount/destination/status under sends[],
        // which rendered blank). The key is `summary`, never `details`: a BET feed
        // member already carries its raw base64 DETAILS string on that key.
        for(let member of data.actions){
            if(!member || typeof member !== 'object') continue;
            let { details, status } = db.projectActionSummary(member);
            member.summary = details;
            if(db.util.isNull(member.status))
                member.status = status;
        }
    },
};

const BROADCAST = {
    effects: { credits: false, debits: false, escrows: false },
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.BROADCAST_QUERY;
        return { query, query2, query3 };
    },
};

const CALLBACK = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.CALLBACK_QUERY;

        return { query, query2, query3 };
    },
};

const FILE = {
    queries({ type }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.FILE_QUERY;
        // TODO: Add code to lookup actual file data from transactions and return an `data` item
        return { query, query2, query3 };
    },
};

const MESSAGE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.MESSAGE_QUERY;
        return { query, query2, query3 };
    },
};

const SLEEP = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.SLEEP_QUERY;
        return { query, query2, query3 };
    },
};

const LIST = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.LIST_QUERY;
        query2 = sql.LIST_QUERY2;
        query3 = sql.LIST_QUERY3;
        return { query, query2, query3 };
    },
    // Populate the list from the membership rows, keyed off the list TYPE field
    // (1 = tokens, 2 = addresses).
    afterQuery2(ctx, data, results) {
        let list = [];
        for(let row of results){
            if(data.type==1) list.push(row.tick);
            if(data.type==2) list.push(row.address);
        }
        data.list = list.sort();
    },
    afterQuery3(ctx, data, results) {
        let edits = [];
        for(let row of results){
            if(data.type==1) edits.push({ tick: row.tick, status: row.status });
            if(data.type==2) edits.push({ address: row.address, status: row.status });
        }
        data.edits = edits.sort();
    },
    // `list` above is the membership THIS action wrote, which for a
    // create is its create-time snapshot and for an edit is that edit's
    // result. Current membership lives under the head of the edit chain, so
    // it is derived here and lands in `state` for two reasons: it is
    // recomputed from rows written AFTER this action (the same shape as
    // DISPENSER/ORDER/SWAP state), and `state` is precisely what the
    // isCacheableAction guard keys on. Without it the LRU would serve one
    // membership for the life of the process and every later edit would be
    // invisible, a stale-cache failure repeated on a new field.
    async afterQueries({ db, config, action_index }, data) {
        data.state = await db.getListCurrentMembership(config, action_index, data.type);
    },
};

const UNKNOWN = {
    // An action name the protocol does not define has no detail table of its own, so
    // the page comes straight from `actions` and is always shown as invalid.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.UNKNOWN_QUERY;
        return { query, query2, query3 };
    },
};

module.exports = {
    ADDRESS,
    BATCH,
    BROADCAST,
    CALLBACK,
    FILE,
    MESSAGE,
    SLEEP,
    LIST,
    UNKNOWN
};
