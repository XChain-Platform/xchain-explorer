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
 *
 * XChain Explorer - dispenser action list readers
 *
 * Provides one prototype part composed by src/db/readers/action_lists.js.
 *
 ********************************************************************/

'use strict';

const GET_DISPENSERS_COUNT_SQL = `SELECT
                        count(*) as total
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE `;

const GET_DISPENSERS_QUERY_SQL = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as address,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_escrow,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        a5.address as oracle_address,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=m.oracle_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE `;

const GET_DISPENSER_CLOSES_COUNT_SQL = `SELECT
                        count(*) as total
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
                    WHERE `;

const GET_DISPENSER_CLOSES_QUERY_SQL = `SELECT
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
                        s1.status,
                        -- WHY the dispenser closed ('empty' after an auto-drain, 'cancelled'
                        -- after the DISPENSER_CLOSE_DELAY elapses on a cancel). Without it the
                        -- two closes are indistinguishable on the wire: every other column of a
                        -- drained close and a cancelled one is identical, so a reader cannot tell
                        -- a dispenser that ran dry from one its owner withdrew. Joined on the
                        -- CLOSE's own action_index, not on the dispenser's latest status, because
                        -- dispenser_close.js writes exactly one dispenser_statuses row keyed that
                        -- way (createDispenserStatus(data['ACTION_INDEX'], ...)) - so this is a
                        -- point read of the reason THIS close recorded, immune to any later row.
                        s2.status as close_reason
                    FROM
                        dispenser_closes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN dispenser_statuses ds ON (ds.action_index=m.action_index)
                        LEFT  JOIN index_statuses     s2 ON (s2.id=ds.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=d1.get_tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                    WHERE `;

const GET_DISPENSES_COUNT_SQL = `SELECT
                        count(*) as total
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
                    WHERE `;

const GET_DISPENSES_QUERY_SQL = `SELECT
                        a4.action,
                        m.action_index,
                        m.dispenser_action_index,
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
                    WHERE `;

class DispenserReaders {

    // TODO: update this SQL to pull all fields once dispensers are implemented in indexer
    async getDispensers(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = GET_DISPENSERS_COUNT_SQL + sql.where.data;
        let query = GET_DISPENSERS_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getDispenserCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserCloses(config){
        let sql   = config.data.sql;
        let count = GET_DISPENSER_CLOSES_COUNT_SQL + sql.where.data;
        let query = GET_DISPENSER_CLOSES_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        m.give_escrow,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenses(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // get_amount here is dispenses.get_amount (a fill), not dispensers.get_amount
        // (a price). When one payment fills several dispensers behind the same
        // address in a batch, each fill's get_amount is its share of the payment
        // rather than the whole payment restated per row (mainnet not yet armed;
        // testnet/regtest already this way) - do not "fix" this label back to the
        // whole-payment reading, see protocol/actions/dispenser.md "One Payment,
        // Several Dispensers".
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = GET_DISPENSES_COUNT_SQL + sql.where.data;
        let query = GET_DISPENSES_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }
}

module.exports = DispenserReaders.prototype;
