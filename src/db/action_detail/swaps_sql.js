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
 * SQL text for the detail handlers of the SWAP market: SWAP and its
 * cancel, edit, expire and match legs. Each constant is one whole
 * statement that src/action-detail/markets.js hands to action_detail_io.js
 * or runs itself; the action-detail golden pins every one.
 ********************************************************************/

'use strict';

// Read one SWAP with its latest status and both legs.
const SWAP_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Get a list of swap edits: later changes to this swap's expiration
// and allow/block lists
const SWAP_EDITS = `SELECT
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

// Read one SWAP_CANCEL with the terms of the swap it cancelled.
const SWAP_CANCEL_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Read one SWAP_EDIT with the terms of the swap it changed.
const SWAP_EDIT_DETAIL = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
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

// Read one SWAP_EXPIRE with the terms of the swap that expired.
const SWAP_EXPIRE_DETAIL = `SELECT
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

// Read one SWAP_MATCH settlement with both of its legs.
const SWAP_MATCH_DETAIL = `SELECT
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

module.exports = {
    SWAP_DETAIL,
    SWAP_EDITS,
    SWAP_CANCEL_DETAIL,
    SWAP_EDIT_DETAIL,
    SWAP_EXPIRE_DETAIL,
    SWAP_MATCH_DETAIL
};
