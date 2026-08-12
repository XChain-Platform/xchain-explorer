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

const ADDRESS = {
    effects: { credits: false, debits: false, escrows: false },
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        // Rooted at `actions`, with the preferences row LEFT joined, because that row is OPTIONAL: an
        // ADDRESS format 1 (controller bind) is not a preferences edit and older chains carry no
        // `addresses` row for one at all. The INNER JOIN this replaces matched nothing for a v1, so the
        // whole endpoint degraded to the de-blank baseline and served a bind with no status and no
        // verdict, the same failure shape as an earlier memo-join regression.
        query = `SELECT
                    a3.action,
                    a2.action_format,
                    a2.action_index,
                    a4.address as source,
                    a1.fee_preference,
                    a1.require_memo,
                    a1.dispenser_preference,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    actions a2
                    INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN addresses          a1 ON (a1.action_index=a2.action_index)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    a2.action_index=?
                LIMIT 1`;
        // What a format 1 actually did lives in address_controllers, never in the preferences row. The
        // lookup is keyed by this action_index, so it answers nothing for any other format and the
        // shaping hook simply never fires. A REFUSED bind has no row here by design (the log is what
        // consensus enforces); its verdict is the `status` above.
        query2 = `SELECT
                    c1.action_class,
                    c1.contract_index,
                    c1.is_unbind,
                    c1.cooldown_blocks,
                    c1.cooldown_end_block
                FROM
                    address_controllers c1
                WHERE
                    c1.action_index=?
                LIMIT 1`;
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
        query = `SELECT
                    a3.action,
                    a2.action_format,
                    b1.action_index,
                    a4.address as source,
                    b2.block_index,
                    b2.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    batches b1
                    INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                    INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    b1.action_index=?
                LIMIT 1`;
        query2 = `SELECT
                    a1.action_index
                FROM
                    actions a1
                WHERE
                    a1.action_index!=? AND 
                    a1.tx_index=?
                ORDER BY 
                    a1.action_index ASC`;
        return { query, query2, query3 };
    },
    // A batch renders each member action exactly as its own page would, so the
    // children are fetched by recursing into getActionData. query2 is keyed by
    // the batch's transaction, hence the second argument.
    query2Args({ action_index }, data) {
        return [action_index, data.tx_index];
    },
    async afterQuery2({ db, config }, data, results) {
        let actions = [];
        for(let row of results){
            let info = await db.getActionData(config, Number(row.action_index));
            actions.push(info);
        }
        data.actions = actions;
    },
};

const BROADCAST = {
    effects: { credits: false, debits: false, escrows: false },
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    b1.action_index,
                    b1.message,
                    b1.value,
                    b1.fee as broadcast_fee,
                    b1.broadcast_action_index,
                    a3.address as source,
                    b2.block_index,
                    b2.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    broadcasts b1
                    INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    b1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const CALLBACK = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    c1.action_index,
                    a3.address as source,
                    t3.tick,
                    t4.tick as callback_tick,
                    c1.callback_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    callbacks c1
                    INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                WHERE 
                    c1.action_index=?
                LIMIT 1`;

        return { query, query2, query3 };
    },
};

const FILE = {
    queries({ type }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    f1.action_index,
                    f1.name,
                    f1.title,
                    t3.type as type,
                    a3.address as source,
                    gf.gate_ticker,
                    gf.gate_min_amount,
                    gf.encryption_method,
                    gf.key_hash,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    files f1
                    INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
                WHERE
                    f1.action_index=?
                LIMIT 1`;
        // TODO: Add code to lookup actual file data from transactions and return an `data` item
        return { query, query2, query3 };
    },
};

const MESSAGE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m1.action_index,
                    a3.address as source,
                    a4.address as destination,
                    m1.encryption_method,
                    m1.encryption_key,
                    m1.encrypted_message,
                    m1.plaintext_message,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status,
                    m1.coin
                FROM
                    messages m1
                    INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    m1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SLEEP = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    s1.action_index,
                    s1.type,
                    a3.address as source,
                    t3.tick,
                    s1.resume_block,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status
                FROM
                    sleeps s1
                    INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                WHERE 
                    s1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const LIST = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    l1.action_index,
                    l1.type,
                    l1.edit,
                    l1.list_action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    lists l1
                    INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    l1.action_index=?
                LIMIT 1`;
        // List
        query2 = `SELECT
                    a1.address,
                    t1.tick
                FROM
                    list_items l1
                    LEFT JOIN index_addresses a1 ON (a1.id=l1.item_id)
                    LEFT JOIN index_tickers   t1 ON (t1.id=l1.item_id)
                WHERE
                    l1.action_index=?`;
        query3 = `SELECT
                    a1.address,
                    t1.tick,
                    s1.status
                FROM
                    list_edits l1
                    LEFT  JOIN index_statuses  s1 ON (s1.id=l1.status_id)
                    LEFT JOIN  index_addresses a1 ON (a1.id=l1.item_id)
                    LEFT JOIN  index_tickers   t1 ON (t1.id=l1.item_id)
                WHERE 
                    l1.action_index=?`;
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
    // _isCacheableAction guard keys on. Without it the LRU would serve one
    // membership for the life of the process and every later edit would be
    // invisible, a stale-cache failure repeated on a new field.
    async afterQueries({ db, config, action_index }, data) {
        data.state = await db.getListCurrentMembership(config, action_index, data.type);
    },
};

const UNKNOWN = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    'invalid' as status,
                    t1.tx_index
                FROM
                    actions                       a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                WHERE 
                    a1.action_index=?
                LIMIT 1`;
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
