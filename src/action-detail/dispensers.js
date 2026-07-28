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

const COINPAY = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    a3.address as source,
                    m.obligation_action_index,
                    m.coin_amount,
                    m.txid,
                    m.vout,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    coinpays m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const COINPAY_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.obligation_action_index,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    coinpay_expires m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DISPENSER = {
    // DISPENSER action
    queries({ action_index }) {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    d1.action_index,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    d1.give_amount,
                    d1.give_ownership,
                    d1.give_escrow,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    d1.get_amount,
                    a3.address as source,
                    a4.address as get_address,
                    f1.code as fiat_code,
                    d1.fiat_amount,
                    a5.address as oracle_address,
                    d1.expiration,
                    d1.allow_list,
                    d1.block_list,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status,
                    s3.status as current_status,
                    ia.address as cancelled_by
                FROM
                    dispensers d1
                    INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=d1.memo_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                    LEFT  JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=d1.status_id)
                    LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                    LEFT  JOIN index_addresses    ia ON (ia.id=s1.cancelled_by_id)
                WHERE
                    (s1.action_index IS NULL OR s1.action_index = (
                        SELECT
                            MAX(s4.action_index)
                        FROM
                            dispenser_statuses s4
                        WHERE
                            s4.dispenser_action_index=d1.action_index
                    )) AND
                    d1.action_index=?
                LIMIT 1`;
        // Get a list of dispenser edits. Escrow is NOT derived from these rows
        // any more: give_escrow / escrow_remaining come from the shared
        // getDispenserEscrowBatch , so this lane only carries the
        // expiration and allow/block-list edits into state.
        // b.block_time is the edit's own confirmation timestamp and is what
        // gates allow/block-list activation below . Without the
        // actions->blocks join it came back undefined, bcadd() coerced it to 0
        // and every list edit read as already active, so DISPENSER_LIST_DELAY
        // was ignored on the read path. The join mirrors the indexer's
        // getDispenserEdits() so both sides gate on the same value. ORDER BY is
        // qualified because `actions` also has an action_index column.
        query2 = `SELECT
                    m.expiration,
                    m.allow_list,
                    m.block_list,
                    b.block_time
                FROM
                    dispenser_edits m
                    INNER JOIN actions        a ON (a.action_index=m.action_index)
                    INNER JOIN blocks         b ON (b.block_index=a.block_index)
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index=? AND
                    s.status='valid'
                ORDER BY m.action_index ASC`;
        return { query, query2, query3 };
    },
    afterMain:   shared.applyOfferState,
    afterQuery2: shared.applyOfferListEdits,
};

const DISPENSER_CANCEL = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.dispenser_action_index,
                    a3.address as source,
                    a4.address as dispenser_address,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    d1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    d1.get_amount,
                    f1.code as fiat,
                    d1.fiat_amount,
                    a5.address as oracle_address,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s1.status
                FROM
                    dispenser_cancels m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DISPENSER_CLOSE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format, 
                    m.dispenser_action_index,
                    a2.address as dispenser_address,
                    c1.coin as give_coin,
                    t2.tick as give_tick,
                    d1.give_amount,
                    c2.coin as get_coin,
                    t3.tick as get_tick,
                    d1.get_amount,
                    f1.code as fiat,
                    d1.fiat_amount,
                    a5.address as oracle_address,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    dispenser_closes m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                    INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                    LEFT  JOIN index_tickers      t2 ON (t2.id=d1.give_tick_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.get_tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DISPENSER_EDIT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.dispenser_action_index,
                    a3.address as source,
                    a4.address as dispenser_address,
                    c1.coin as give_coin,
                    t3.tick as give_tick,
                    d1.give_amount,
                    c2.coin as get_coin,
                    t4.tick as get_tick,
                    d1.get_amount,
                    m.give_escrow,
                    m.expiration,
                    m.allow_list,
                    m.block_list,
                    f1.code as fiat,
                    d1.fiat_amount,
                    a5.address as oracle_address,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s1.status
                FROM
                    dispenser_edits m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                    LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DISPENSER_EXPIRE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format, 
                    m.dispenser_action_index,
                    a2.address as dispenser_address,
                    c1.coin as give_coin,
                    t2.tick as give_tick,
                    d1.give_amount,
                    c2.coin as get_coin,
                    t3.tick as get_tick,
                    d1.get_amount,
                    f1.code as fiat,
                    d1.fiat_amount,
                    a5.address as oracle_address,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status
                FROM
                    dispenser_expires m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                    INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                    LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                    LEFT  JOIN index_tickers      t2 ON (t2.id=d1.give_tick_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=d1.get_tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                    LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const DISPENSE = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                a4.action,
                m.action_index,
                a1.action_format, 
                a2.address as source,
                a3.address as destination,
                c1.coin as give_coin,
                t3.tick as give_tick,
                m.give_amount,
                c2.coin as get_coin,
                t4.tick as get_tick,
                m.get_amount,
                b1.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                dispenses m
                INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
            WHERE 
                m.action_index=?
            LIMIT 1`;
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
