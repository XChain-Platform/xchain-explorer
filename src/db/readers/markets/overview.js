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
 * XChain Explorer - market overview readers
 *
 * Provides one prototype part composed by src/db/readers/markets.js.
 *
 ********************************************************************/

'use strict';

// How a market side is named when it may have no ticker. The SQL half of this is
// COALESCE(ticker, coin); the order feeds hand back the two fields separately, so
// the JS half has to make the same choice before comparing against a caller's tick.
function marketSideLabel(tick, coin){
    return (tick === null || tick === undefined || tick === '') ? coin : tick;
}

const GET_MARKETS_COUNT_SQL = `SELECT
                        count(*) as total
                    FROM
                        markets m
                        LEFT JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        LEFT JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                        LEFT JOIN index_coins   c1 ON (c1.id=m.coin1_id)
                        LEFT JOIN index_coins   c2 ON (c2.id=m.coin2_id)
                    WHERE `;

const GET_MARKETS_QUERY_SQL = `SELECT
                        m.id,
                        COALESCE(t1.tick, c1.coin) as tick1,
                        m.tick1_price,
                        m.tick1_bid,
                        m.tick1_ask,
                        m.tick1_24hr_price,
                        m.tick1_24hr_high,
                        m.tick1_24hr_low,
                        m.tick1_24hr_change,
                        m.tick1_24hr_volume,
                        COALESCE(t2.tick, c2.coin) as tick2,
                        m.tick2_price,
                        m.tick2_bid,
                        m.tick2_ask,
                        m.tick2_24hr_price,
                        m.tick2_24hr_high,
                        m.tick2_24hr_low,
                        m.tick2_24hr_change,
                        m.tick2_24hr_volume,
                        m.last_updated
                    FROM
                        markets m
                        LEFT JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        LEFT JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                        LEFT JOIN index_coins   c1 ON (c1.id=m.coin1_id)
                        LEFT JOIN index_coins   c2 ON (c2.id=m.coin2_id)
                    WHERE `;

const GET_MARKET_QUERY_SQL = `SELECT
                        m.id,
                        COALESCE(t1.tick, c1.coin) as tick1,
                        m.tick1_price,
                        m.tick1_bid,
                        m.tick1_ask,
                        m.tick1_24hr_price,
                        m.tick1_24hr_high,
                        m.tick1_24hr_low,
                        m.tick1_24hr_change,
                        m.tick1_24hr_volume,
                        COALESCE(t2.tick, c2.coin) as tick2,
                        m.tick2_price,
                        m.tick2_bid,
                        m.tick2_ask,
                        m.tick2_24hr_price,
                        m.tick2_24hr_high,
                        m.tick2_24hr_low,
                        m.tick2_24hr_change,
                        m.tick2_24hr_volume,
                        m.last_updated
                    FROM
                        markets m
                        LEFT JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        LEFT JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                        LEFT JOIN index_coins   c1 ON (c1.id=m.coin1_id)
                        LEFT JOIN index_coins   c2 ON (c2.id=m.coin2_id)
                    WHERE `;

const GET_MARKET_HISTORY_COUNT_SQL = `SELECT
                        count(*) as total
                    FROM
                        order_matches m
                        INNER JOIN orders             o1 ON (o1.action_index=m.give_action_index)
                        INNER JOIN orders             o2 ON (o2.action_index=m.get_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=o1.get_address_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=o2.get_address_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    WHERE 
                        `;

const GET_MARKET_HISTORY_QUERY_SQL = `SELECT
                            m.action_index,
                            COALESCE(t1.tick, c1.coin) as give_tick,
                            COALESCE(t2.tick, c2.coin) as get_tick,
                            m.give_amount,
                            m.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp
                        FROM
                            order_matches m
                            INNER JOIN orders             o1 ON (o1.action_index=m.give_action_index)
                            INNER JOIN orders             o2 ON (o2.action_index=m.get_action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                            LEFT  JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=o1.get_address_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=o2.get_address_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        WHERE 
                            `;

class MarketOverviewReaders {
    /******************************************************************
     * XChain API Market Endpoints
     * 
     * Endpoints                                          Method Name  
     * -----------------------------------------------------------------
     * /{COIN}/api/markets                                getMarkets
     * /{COIN}/api/markets/{QUERY}                        getMarkets
     * /{COIN}/api/market/{QUERY}/{QUERY}                 getMarket
     * /{COIN}/api/market/{QUERY}/{QUERY}/history         getMarketHistory
     * /{COIN}/api/market/{QUERY}/{QUERY}/history/{QUERY} getMarketHistory
     * /{COIN}/api/market/{QUERY}/{QUERY}/orders/{QUERY}  getMarketOrders
     * /{COIN}/api/market/{QUERY}/{QUERY}/orderbook       getOrderbook
     ******************************************************************/

    async getMarkets(config){
        let data  = [];
        let total = 0;
        let tick  = config.data.search;
        let sql   = config.data.sql;
        let args  = [tick, tick];
        let count = GET_MARKETS_COUNT_SQL + sql.where.data;
        let query = GET_MARKETS_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(count){
            results = await this.doQuery(config, query, args);
            if(results.length > 0){
                for(let row of results){
                    let reverse = (!this.util.isNull(tick) && String(tick).toLowerCase()==String(row.tick2).toLowerCase()) ? true : false;
                    data.push({
                        id                : row.id,
                        tick1             : (reverse) ? row.tick1             : row.tick2,
                        tick1_price       : (reverse) ? row.tick1_price       : row.tick2_price,
                        tick1_bid         : (reverse) ? row.tick1_bid         : row.tick2_bid,
                        tick1_ask         : (reverse) ? row.tick1_ask         : row.tick2_ask,
                        tick1_24hr_price  : (reverse) ? row.tick1_24hr_price  : row.tick2_24hr_price,
                        tick1_24hr_high   : (reverse) ? row.tick1_24hr_high   : row.tick2_24hr_high,
                        tick1_24hr_low    : (reverse) ? row.tick1_24hr_low    : row.tick2_24hr_low,
                        tick1_24hr_change : (reverse) ? row.tick1_24hr_change : row.tick2_24hr_change,
                        tick1_24hr_volume : (reverse) ? row.tick1_24hr_volume : row.tick2_24hr_volume,
                        tick2             : (reverse) ? row.tick2             : row.tick1,
                        tick2_price       : (reverse) ? row.tick2_price       : row.tick1_price,
                        tick2_bid         : (reverse) ? row.tick2_bid         : row.tick1_bid,
                        tick2_ask         : (reverse) ? row.tick2_ask         : row.tick1_ask,
                        tick2_24hr_price  : (reverse) ? row.tick2_24hr_price  : row.tick1_24hr_price,
                        tick2_24hr_high   : (reverse) ? row.tick2_24hr_high   : row.tick1_24hr_high,
                        tick2_24hr_low    : (reverse) ? row.tick2_24hr_low    : row.tick1_24hr_low,
                        tick2_24hr_change : (reverse) ? row.tick2_24hr_change : row.tick1_24hr_change,
                        tick2_24hr_volume : (reverse) ? row.tick2_24hr_volume : row.tick1_24hr_volume,
                        last_updated      : row.last_updated
                    });
                }
            }
        }
        return [data, null, total];
    } 

    async getMarket(config){
        let data  = [];
        let total = 0;
        let tick1 = config.data.search;
        let tick2 = config.data.search2;
        let sql   = config.data.sql;
        let args  = [tick1, tick2, tick2, tick1];
        let query = GET_MARKET_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                let reverse = (!this.util.isNull(tick2) && String(tick2).toLowerCase()==String(row.tick2).toLowerCase()) ? true : false;
                data.push({
                    id                : row.id,
                    tick1             : (reverse) ? row.tick1             : row.tick2,
                    tick1_price       : (reverse) ? row.tick1_price       : row.tick2_price,
                    tick1_bid         : (reverse) ? row.tick1_bid         : row.tick2_bid,
                    tick1_ask         : (reverse) ? row.tick1_ask         : row.tick2_ask,
                    tick1_24hr_price  : (reverse) ? row.tick1_24hr_price  : row.tick2_24hr_price,
                    tick1_24hr_high   : (reverse) ? row.tick1_24hr_high   : row.tick2_24hr_high,
                    tick1_24hr_low    : (reverse) ? row.tick1_24hr_low    : row.tick2_24hr_low,
                    tick1_24hr_change : (reverse) ? row.tick1_24hr_change : row.tick2_24hr_change,
                    tick1_24hr_volume : (reverse) ? row.tick1_24hr_volume : row.tick2_24hr_volume,
                    tick2             : (reverse) ? row.tick2             : row.tick1,
                    tick2_price       : (reverse) ? row.tick2_price       : row.tick1_price,
                    tick2_bid         : (reverse) ? row.tick2_bid         : row.tick1_bid,
                    tick2_ask         : (reverse) ? row.tick2_ask         : row.tick1_ask,
                    tick2_24hr_price  : (reverse) ? row.tick2_24hr_price  : row.tick1_24hr_price,
                    tick2_24hr_high   : (reverse) ? row.tick2_24hr_high   : row.tick1_24hr_high,
                    tick2_24hr_low    : (reverse) ? row.tick2_24hr_low    : row.tick1_24hr_low,
                    tick2_24hr_change : (reverse) ? row.tick2_24hr_change : row.tick1_24hr_change,
                    tick2_24hr_volume : (reverse) ? row.tick2_24hr_volume : row.tick1_24hr_volume,
                    last_updated      : row.last_updated
                });
            }
        }
        return data;
    }

    async getMarketHistory(config){
        let data    = [];
        let total   = 0;
        let tick1   = config.data.search;
        let tick2   = config.data.search2;
        let address = config.data.search3;
        let sql     = config.data.sql;
        let args    = [tick1, tick2, tick2, tick1];
        if(!this.util.isNull(address))
            args.push(address, address);
        let count = GET_MARKET_HISTORY_COUNT_SQL + sql.where.data + ` AND 
                        s1.status='valid'`;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(total){
            let query   = GET_MARKET_HISTORY_QUERY_SQL + sql.where.data + ` AND 
                            s1.status='valid'
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
            let results = await this.doQuery(config, query, args);
            if(results.length > 0){
                for(let order of results){
                    let reverse    = (order.give_tick==tick2) ? true : false;
                    let give_price = this.util.getPrice(order.get_amount, order.give_amount);
                    let get_price  = this.util.getPrice(order.give_amount, order.get_amount);
                    data.push({
                        type         : (reverse) ? 'sell' : 'buy',
                        price        : (reverse) ? get_price : give_price,
                        amount       : (reverse) ? this.util.bcnum(order.get_amount) : this.util.bcnum(order.give_amount),
                        action_index : order.action_index,
                        block_index  : order.block_index,
                        timestamp    : order.timestamp
                    });
                }
            }
        }
        return [data, null, total];
    }
}

module.exports = MarketOverviewReaders.prototype;
