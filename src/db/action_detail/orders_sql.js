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
 * SQL text for the detail handlers of the ORDER market: ORDER and its
 * cancel, edit, expire and match legs. Each constant is one whole
 * statement that src/action-detail/markets.js hands to action_detail_io.js
 * or runs itself; the action-detail golden pins every one.
 ********************************************************************/

'use strict';

// Read one ORDER with its latest status and both legs.
const ORDER_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Get a list of order edits: later changes to this order's expiration
// and allow/block lists
const ORDER_EDITS = `SELECT
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

// Get a list of order matches, so the page can show how much of the
// order is still unfilled
const ORDER_MATCHES = `SELECT
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

// Read one ORDER_CANCEL with the terms of the order it cancelled.
const ORDER_CANCEL_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Read one ORDER_EDIT with the terms of the order it changed.
const ORDER_EDIT_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Read one ORDER_EXPIRE with the terms of the order that expired.
const ORDER_EXPIRE_DETAIL = `SELECT
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

// Read one ORDER_MATCH fill with both of its legs.
const ORDER_MATCH_DETAIL = `SELECT
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

module.exports = {
    ORDER_DETAIL,
    ORDER_EDITS,
    ORDER_MATCHES,
    ORDER_CANCEL_DETAIL,
    ORDER_EDIT_DETAIL,
    ORDER_EXPIRE_DETAIL,
    ORDER_MATCH_DETAIL
};
