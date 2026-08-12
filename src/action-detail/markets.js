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

const ORDER = {
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    o1.action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    o1.give_amount,
                    o1.give_ownership,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    o1.get_amount,
                    o1.get_ownership,
                    a3.address as source,
                    a4.address as get_address,
                    o1.expiration,
                    o1.allow_list,
                    o1.block_list,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status,
                    s3.status as current_status
                FROM
                    orders o1
                    INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN order_statuses     s1 ON (s1.order_action_index=o1.action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=o1.status_id)
                    LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                WHERE
                    (s1.action_index IS NULL OR s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            order_statuses s3
                        WHERE
                            s3.order_action_index=o1.action_index
                    )) AND
                    o1.action_index=?
                LIMIT 1`;
        query2 = `SELECT
                    m.expiration,
                    m.allow_list,
                    m.block_list
                FROM
                    order_edits m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.order_action_index=? AND
                    s.status='valid'
                ORDER BY action_index ASC`;
        query3 = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status='valid'
                ORDER BY action_index ASC`;
        return { query, query2, query3 };
    },
    afterMain:   shared.applyOfferState,
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
    },
};

const ORDER_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.order_action_index,
                    a3.address as source,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    o1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    o1.get_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s1.status
                FROM
                    order_cancels m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const ORDER_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.order_action_index,
                    a3.address as source,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    o1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    o1.get_amount,
                    m.expiration,
                    m.allow_list,
                    m.block_list,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s1.status
                FROM
                    order_edits m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const ORDER_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.order_action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    o1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    o1.get_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    order_expires m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const ORDER_MATCH = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m1.action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    m1.give_amount,
                    m1.give_action_index,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    m1.get_amount,
                    m1.get_action_index,
                    m1.settlement_type,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    order_matches m1
                    INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=m1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=m1.get_tick_id)
                WHERE 
                    m1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SWAP = {
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    s1.action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    s1.give_amount,
                    s1.give_ownership,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    s1.get_amount,
                    s1.get_ownership,
                    a3.address as source,
                    a4.address as get_address,
                    s1.expiration,
                    s1.allow_list,
                    s1.block_list,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s3.status,
                    s4.status as current_status
                FROM
                    swaps s1
                    LEFT  JOIN swap_statuses      s2 ON (s2.swap_action_index=s1.action_index)
                    INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                    LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                    LEFT  JOIN index_statuses     s4 ON (s4.id=s2.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                WHERE
                    (s2.action_index IS NULL OR s2.action_index = (
                        SELECT
                            MAX(s4.action_index)
                        FROM
                            swap_statuses s4
                        WHERE
                            s4.swap_action_index=s1.action_index
                    )) AND
                    s1.action_index=?
                LIMIT 1`;
        query2 = `SELECT
                    m.expiration,
                    m.allow_list,
                    m.block_list
                FROM
                    swap_edits m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.swap_action_index=? AND
                    s.status='valid'
                ORDER BY action_index ASC`;
        return { query, query2, query3 };
    },
    afterMain:   shared.applyOfferState,
    afterQuery2: shared.applyOfferListEdits,
};

const SWAP_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.swap_action_index,
                    a3.address as source,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    s1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    s1.get_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status
                FROM
                    swap_cancels m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SWAP_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.swap_action_index,
                    a3.address as source,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    s1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    s1.get_amount,
                    m.expiration,
                    m.allow_list,
                    m.block_list,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status
                FROM
                    swap_edits m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SWAP_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.swap_action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    s1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    s1.get_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s2.status
                FROM
                    swap_expires m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                WHERE 
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SWAP_MATCH = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m1.action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    m1.give_amount,
                    m1.give_action_index,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    m1.get_amount,
                    m1.get_action_index,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    swap_matches m1
                    INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=m1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=m1.get_tick_id)
                WHERE 
                    m1.action_index=?
                LIMIT 1`;
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
