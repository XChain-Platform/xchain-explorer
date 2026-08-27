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

const AIRDROP = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a3.action,
                    a2.action_format,
                    a1.action_index,
                    a4.address as source,
                    t3.tick,
                    a1.list_action_index,
                    a1.amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    airdrops a1
                    INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                WHERE 
                    a1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DESTROY = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    d1.action_index,
                    a3.address as source,
                    t3.tick,
                    d1.amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    destroys d1
                    INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                WHERE
                    d1.action_index=?
                LIMIT 1`;
        // Read every leg: action_index is non-unique here (one row per leg) so
        // the LIMIT 1 header above carries an arbitrary one. Take NO ORDER BY:
        // destroys records no leg position, so a sort reorders the wire.
        query2 = `SELECT
                    t1.tick,
                    d1.amount,
                    m1.memo,
                    s1.status
                FROM
                    destroys d1
                    LEFT  JOIN index_tickers      t1 ON (t1.id=d1.tick_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                WHERE
                    d1.action_index=?`;
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
        query = `SELECT
                a4.action,
                m.action_index,
                a1.action_format, 
                a2.address as source,
                t3.tick,
                t4.tick as dividend_tick,
                m.amount,
                b1.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                m1.memo,
                s1.status
            FROM
                dividends m
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
            WHERE 
                m.action_index=?
            LIMIT 1`;
        return { query, query2, query3 };
    },
};

const ISSUE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    i1.action_index,
                    t3.tick,
                    i1.max_supply,
                    i1.max_mint,
                    i1.decimals,
                    i1.description,
                    i1.mint_supply,
                    a4.address as transfer,
                    a5.address as transfer_supply,
                    i1.lock_max_supply,
                    i1.lock_mint,
                    i1.lock_mint_supply,
                    i1.lock_max_mint,
                    i1.lock_description,
                    i1.lock_sleep,
                    i1.lock_callback,
                    i1.callback_block,
                    t4.tick as callback_tick,
                    i1.callback_amount,
                    i1.allow_list,
                    i1.block_list,
                    i1.mint_address_max,
                    i1.mint_start_block,
                    i1.mint_stop_block,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    issues i1
                    INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=i1.memo_id)
                WHERE 
                    i1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const LINK = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    l1.action_index,
                    c1.coin as coin1,
                    c2.coin as coin2,
                    l1.coin1_action_index,
                    l1.coin2_action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    links l1
                    INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
                WHERE 
                    l1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const MINT = {
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
                    t3.tick,
                    m1.amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s1.status
                FROM
                    mints m1
                    INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                WHERE 
                    m1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const SEND = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    s1.action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    sends s1
                    INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    s1.action_index=?
                LIMIT 1`;
        query2 = `SELECT
                    a1.address as destination,
                    t1.tick,
                    s1.amount,
                    m1.memo,
                    s2.status
                FROM
                    sends s1
                    LEFT  JOIN index_addresses    a1 ON (a1.id=s1.destination_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=s1.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    LEFT  JOIN index_tickers      t1 ON (t1.id=s1.tick_id)
                WHERE 
                    s1.action_index=?`;
        return { query, query2, query3 };
    },
    afterQuery2(ctx, data, results) {
        data.sends = results;
    },
};

const SWEEP = {
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    s1.action_index,
                    a3.address as source,
                    a4.address as destination,
                    s1.balances,
                    s1.ownerships,
                    s1.orders,
                    s1.swaps,
                    s1.dispensers,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status
                FROM
                    sweeps s1
                    INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    s1.action_index=?
                LIMIT 1`;
        // TODO: Update query once each sweep issue is its own action_index
        query2 = `SELECT
                    a1.address,
                    t1.tick
                FROM
                    issues i1
                    LEFT  JOIN index_tickers   t1 ON (t1.id=i1.tick_id)
                    LEFT  JOIN index_addresses a1 ON (a1.id=i1.transfer_id)
                WHERE 
                    i1.action_index=?
                ORDER BY
                    t1.tick ASC`;
        return { query, query2, query3 };
    },
    afterQuery2(ctx, data, results) {
        data.issues = results;
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
    SWEEP
};
