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
 * XChain Explorer - the two entry points every reader goes through
 *
 * One part of src/db/query_sql.js (the entry composes it through
 * composeReaderParts). getData answers a shaped, cacheable page; getQuery
 * answers the raw [query, args, count] triple the readers build. getData is
 * four steps in order, each in a sibling file: the result-cache lookup
 * (data_cache.js), the row and count queries with their bind arguments
 * (data_rows.js), the per-page post-passes (data_post.js), and the cache store.
 * getQuery clamps the transport's paging (query_limits.js), resolves the
 * data-WHERE, and then calls the reader method itself.
 *
 * A method that runs its own reads and returns [object] (getXcall, getPoll, the
 * M4 compositions) short-circuits the arg-assembly path here: getData takes its
 * `typeof query === 'object'` branch instead.
 *
 * Authored as a class body whose prototype is exported, like every other family
 * under src/db/: `this` is the Database instance at call time.
 *
 ********************************************************************/

'use strict';

const { resultCacheLookup, resultCacheStore } = require('./data_cache.js');
const { runListQuery } = require('./data_rows.js');
const { applyPostPasses } = require('./data_post.js');
const { apiPageOffset, explorerLimits, explorerOffsets } = require('./query_limits.js');

const CANONICAL_TICKERS = Symbol('canonicalTickers');
const TICK_FILTER_TYPES = new Set(['token', 'tick', 'gate']);
const TICK_FILTER_METHODS = new Set([
    'getMarket', 'getMarkets', 'getMarketOrders', 'getOrderbook',
    'getMarketHistory', 'getProject', 'getProjectTokens'
]);

async function canonicalTicker(db, config, value){
    if(db.util.isNull(value)) return value;
    let canonical = await db.getCanonicalTick(config, value);
    return db.util.isNull(canonical) ? value : canonical;
}

async function canonicalizeTickerFilters(db, config){
    if(config[CANONICAL_TICKERS]) return;
    let data = config.data || {};
    if(TICK_FILTER_TYPES.has(data.type) || TICK_FILTER_METHODS.has(data.method))
        data.search = await canonicalTicker(db, config, data.search);
    if(['getMarket', 'getMarketOrders', 'getOrderbook', 'getMarketHistory'].includes(data.method))
        data.search2 = await canonicalTicker(db, config, data.search2);
    if(data.method === 'getActions' && data.query && !db.util.isNull(data.query.tick))
        data.query.tick = await canonicalTicker(db, config, data.query.tick);
    config[CANONICAL_TICKERS] = true;
}

class QueryData {

    /******************************************************************
     * General database functions
     *****************************************************************/

    async getData(config){
        let data  = [];
        let total = null;
        await canonicalizeTickerFilters(this, config);
        let { cacheName, cacheKey, hit } = await resultCacheLookup(this, config);
        if(hit)
            return hit;
        let [query, args, count] = await this.getQuery(config);
        if(typeof query === 'object'){
            data = query;
            if(this.util.isNumeric(count))
                total = count;
        } else {
            [data, total] = await runListQuery(this, config, query, args, count);
        }
        data = await applyPostPasses(this, config, data);
        resultCacheStore(this, config, cacheName, cacheKey, data, total);
        return [data, total];
    }

    async getQuery(config){
        await canonicalizeTickerFilters(this, config);
        let count = '';
        let query = '';
        let args  = null;
        let data  = config.data;
        let q     = (data.query) ? data.query : false;
        let max   = this.getMaxMethodResults(data.method);
        let limit = (q && q.limit && this.util.isInteger(Number(q.limit))) ? q.limit : max;
        limit = Math.max(1, Math.min(Number(limit), max));
        let default_order = (['getBalances'].includes(data.method)) ? 'ASC' : 'DESC';
        let order         = (q && q.sortorder && ['ASC','DESC'].includes(String(q.sortorder).toUpperCase())) ? String(q.sortorder).toUpperCase() : default_order;
        if(config.type=='api'){
            apiPageOffset(this, config, q, limit);
        }
        if(config.type=='explorer'){
            ({ limit, order } = explorerLimits(this, config, q, max, limit, order));
            await explorerOffsets(this, config, q, limit);
        }
        config.data.sql.where.data = await this.getQueryWhereSql(config);
        config.data.sql.order = order
        config.data.sql.limit = limit;
        if(typeof this[data.method] === 'function')
            [query, args, count] = await this[data.method](config);
        return [query, args, count];
    }
}

module.exports = QueryData.prototype;
