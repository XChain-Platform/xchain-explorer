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
 * XChain Explorer - single order offer readers
 *
 * One ORDER's row, its valid edits and its remaining amounts after matches,
 * plus the plain decimal rendering the dispenser escrow batch also uses.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// The ORDER row the detail page reads: the order joined to its LATEST status
// transition, which is what makes it read as open, filled or cancelled. Hoisted out
// of the method because it binds nothing but the action_index the caller passes.
const ORDER_INFO_QUERY = `SELECT 
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM 
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index=? 
                    LIMIT 1`;

class OrderReaders {
    // Return order info for given action_index
    async getOrderInfo(config, action_index){
        let order = false;
        let query = ORDER_INFO_QUERY;
        let args  = [action_index];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            order = results[0];
            // Convert BIGINT values to Numbers
            order.action_index = Number(order.action_index);
            order.block_index  = Number(order.block_index);
            order.block_time   = Number(order.block_time);
            order.allow_list   = Number(order.allow_list);
            order.block_list   = Number(order.block_list);
        }
        // Get additional information on this order 
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEditInfo(config, action_index);
            if(edit.expiration) order.expiration = edit.expiration;
            if(edit.allow_list) order.allow_list = edit.allow_list;
            if(edit.block_list) order.block_list = edit.block_list;
            // Determine order get/give prices
            order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
            order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(config, action_index);
            order.give_remaining = give_remaining;
            order.get_remaining  = get_remaining;
        }
        order = this.util.ksort(order);
        return order;
    }

    // Return order edit information for given action_index
    async getOrderEditInfo(config, action_index){
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }    

    async getOrderAmountsRemaining(config, action_index){
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        let query  = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount
                    FROM 
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;  
            give_remaining = info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;  
            get_remaining  = info.get_amount;
        }
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid'];
        results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount);
            }
        }
        return [give_remaining, get_remaining];
    }

    // Render a derived amount as a plain decimal string. mathjs bignumbers
    // stringify to exponential notation below 1e-7 ('3e-8'), which no client
    // parses as an amount, so 18-decimal dust would render unusable.
    amountString(value){
        if(this.util.isNull(value)) return null;
        return (value && typeof value.toFixed === 'function') ? value.toFixed() : String(value);
    }
}

module.exports = OrderReaders.prototype;
