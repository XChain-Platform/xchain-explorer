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
 * XChain Explorer - market order readers
 *
 * Provides one prototype part composed by src/db/readers/markets.js.
 *
 ********************************************************************/

'use strict';

function marketSideLabel(tick, coin){
    return (tick === null || tick === undefined || tick === '') ? coin : tick;
}

const GET_MARKET_ORDERS_COUNT_SQL_1 = `SELECT
                        count(*) as total
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t3 ON (t3.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                        LEFT  JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN order_statuses     s1 ON (s1.order_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE 
                        `;

const GET_MARKET_ORDERS_COUNT_SQL_2 = ` AND 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=m.action_index
                        ) AND
                        s2.status='open'`;

const GET_MARKET_ORDERS_QUERY_SQL_1 = `SELECT
                            m.action_index
                        FROM
                            orders m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            LEFT  JOIN transactions       t3 ON (t3.tx_index=a1.tx_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                            LEFT  JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                            LEFT  JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                            INNER JOIN order_statuses     s1 ON (s1.order_action_index=m.action_index)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        WHERE 
                            `;

const GET_MARKET_ORDERS_QUERY_SQL_2 = ` AND 
                            s1.action_index = (
                                SELECT
                                    MAX(s3.action_index)
                                FROM
                                    order_statuses s3
                                WHERE
                                    s3.order_action_index=m.action_index
                            ) AND
                            s2.status='open'
                        ORDER BY m.action_index `;

const GET_ORDERBOOK_QUERY_SQL_1 = `SELECT
                        m.action_index
                    FROM
                        orders m
                        LEFT  JOIN index_tickers  t1 ON (t1.id=m.give_tick_id)
                        LEFT  JOIN index_tickers  t2 ON (t2.id=m.get_tick_id)
                        LEFT  JOIN index_coins    c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins    c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=m.action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        `;

const GET_ORDERBOOK_QUERY_SQL_2 = ` AND 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=m.action_index
                        ) AND
                        s2.status='open'
                    ORDER BY m.action_index DESC
                    LIMIT 1000`;

class MarketOrderReaders { 

    async getMarketOrders(config){
        let data    = [];
        let total   = 0;
        let tick1   = config.data.search;
        let tick2   = config.data.search2;
        let address = config.data.search3;
        let sql     = config.data.sql;
        let args    = [tick1, tick2, tick2, tick1];
        if(!this.util.isNull(address))
            args.push(address)
        let count = GET_MARKET_ORDERS_COUNT_SQL_1 + sql.where.data + GET_MARKET_ORDERS_COUNT_SQL_2;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(total){
            let query   = GET_MARKET_ORDERS_QUERY_SQL_1 + sql.where.data + GET_MARKET_ORDERS_QUERY_SQL_2 + sql.order + `
                        LIMIT ` + sql.limit;
            let results = await this.doQuery(config, query, args);
            if(results.length > 0){
                // Batch-fetch all order info in one round-trip instead of N+1 queries.
                let action_indexes = results.map(r => Number(r.action_index));
                let orderMap = await this.getOrderInfoBatch(config, action_indexes);
                for(let info of results){
                    let order = orderMap[Number(info.action_index)];
                    if(!order) continue;
                    let reverse = (marketSideLabel(order.give_tick, order.give_coin)==tick2) ? true : false;
                    data.push({
                        type         : (reverse) ? 'buy' : 'sell',
                        price        : (reverse) ? order.get_price : order.give_price,
                        amount       : (reverse) ? order.get_amount : order.give_amount,
                        action_index : order.action_index,
                        timestamp    : order.timestamp,
                        expiration   : order.expiration
                    });
                }
            }
        }
        return [data, null, total];
    } 

    async getOrderbook(config){
        let data   = {
            asks: [],
            bids: []
        };
        let bids   = new Map();
        let asks   = new Map();
        let tick1  = config.data.search;
        let tick2  = config.data.search2;
        let sql    = config.data.sql;
        let args   = [tick1, tick2, tick2, tick1];
        let query  = GET_ORDERBOOK_QUERY_SQL_1 + sql.where.data + GET_ORDERBOOK_QUERY_SQL_2;
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            // Batch fetch all order info in parallel instead of N+1 queries
            let action_indexes = results.map(r => Number(r.action_index));
            let orderMap = await this.getOrderInfoBatch(config, action_indexes);
            for(let info of results){
                let order = orderMap[Number(info.action_index)];
                if(!order) continue;
                let give  = marketSideLabel(order.give_tick, order.give_coin);
                let type  = (give==tick2) ? 'bid' : 'ask';
                let price = (give==tick2) ? order.get_price : order.give_price;
                // Use the exact decimal value as the bucket key so equivalent
                // forms such as 2 and 2.0 share one price level.
                let key = this.util.bcnum(price).toFixed();
                if(type=='bid'){
                    let bid = bids.get(key);
                    if(bid) bid.amount = this.util.bcadd(bid.amount, order.get_remaining);
                    else bids.set(key, { price: price, amount: order.get_remaining });
                }
                if(type=='ask'){
                    let ask = asks.get(key);
                    if(ask) ask.amount = this.util.bcadd(ask.amount, order.give_remaining);
                    else asks.set(key, { price: price, amount: order.give_remaining });
                }
            }
            // Sort asks and bids
            bids = this.util.priceSort([...bids.values()],'DESC');
            asks = this.util.priceSort([...asks.values()],'ASC');
            // Add the bids and asks to the response object
            for(let bid of bids)
                data.bids.push([bid.price, bid.amount]);
            for(let ask of asks)
                data.asks.push([ask.price, ask.amount]);
            data.market = tick1 + '/' + tick2;
        }
        return [data];
    }
}

module.exports = MarketOrderReaders.prototype;
