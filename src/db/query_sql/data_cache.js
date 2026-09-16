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
 * XChain Explorer - the short-TTL result cache getData reads and writes
 *
 * One part of src/db/query_sql.js: the two ends of the cache getData wraps its
 * work in. The lookup resolves the per-request key and answers a live hit; the
 * store writes the shaped page back under that key, size-capped.
 *
 * Plain functions, not a class body: they take the Database as `db` (the caches
 * themselves are per-instance fields) and nothing here reaches
 * Database.prototype.
 *
 ********************************************************************/

'use strict';

// Short-TTL result cache for the unauthenticated filesort-heavy list paths.
// getHolders sorts by ABS(amount) on a VARCHAR column,
// getBalances sorts by tick across a balances/tokens join, and getTokens is a
// multi-table join whose token/subtoken search is a leading-% LIKE: none of
// these have an index-only path, so each call to the public /api or /explorer
// route is a full filesort and a cheap DoS-amplification vector. A small
// per-request-shape cache collapses a request burst into one query. The key
// carries the coin's current tip so a cached answer can never outlive the
// block it was read at (see resultCacheGeneration); the TTL is a ceiling on
// top of that, and each map is size-capped (oldest-evicted) so the cache
// itself cannot grow unbounded. The key is built from the raw request
// inputs (search, type, and every pagination/order query param) BEFORE
// getQuery derives the SQL, so distinct pages/orders never collide.
const RESULT_CACHES = {
    getHolders:  ['_holdersCache',  'EXPLORER_HOLDERS_CACHE'],
    getTokens:   ['_tokensCache',   'EXPLORER_TOKENS_CACHE'],
    getBalances: ['_balancesCache', 'EXPLORER_BALANCES_CACHE']
};

// Resolves the cache this request belongs to and answers a live entry. Returns
// the cache name and key getData carries to the store below, plus `hit`: the
// [data, total] pair to return instead of querying, or null to go to the DB.
async function resultCacheLookup(db, config){
    let cacheName = null;
    let cacheKey  = null;
    if(RESULT_CACHES[config.data.method]){
        let envPrefix;
        [cacheName, envPrefix] = RESULT_CACHES[config.data.method];
        const q = config.data.query || {};
        // Include the per-coin reorg generation (M-3) so a detected reorg
        // makes every pre-reorg result-cache entry unreachable instead of
        // serving reassigned-id rows until the TTL expires, and the coin's
        // current tip so a block that moves the underlying rows does the same
        // A null generation means the tip probe failed; leave
        // cacheKey null so this request neither reads nor writes the cache.
        const gen = await db.resultCacheGeneration(config);
        if(gen === null){
            cacheName = null;
        } else {
            cacheKey = [config.coin, db._reorgGen[config.coin] || 0, gen,
                        config.type, config.data.type, config.data.search,
                        q.page, q.limit, q.sortorder, q.offset, q.start, q.length, q.action].join('|');
            const ttl = parseInt(db.configInfo.env[envPrefix + '_MS'], 10) || 15000;
            if(!db[cacheName]) db[cacheName] = new Map();
            const hit = db[cacheName].get(cacheKey);
            if(hit && (Date.now() - hit.at) < ttl)
                return { cacheName, cacheKey, hit: [hit.data, hit.total] };
        }
    }
    return { cacheName, cacheKey, hit: null };
}

// Populate the result cache. Cap each map and evict the oldest entry on
// overflow so a flood of distinct ticks/addresses/pages cannot grow the
// cache without bound.
function resultCacheStore(db, config, cacheName, cacheKey, data, total){
    if(cacheKey !== null){
        const envPrefix = RESULT_CACHES[config.data.method][1];
        const MAX = parseInt(db.configInfo.env[envPrefix + '_MAX'], 10) || 500;
        if(db[cacheName].size >= MAX)
            db[cacheName].delete(db[cacheName].keys().next().value);
        db[cacheName].set(cacheKey, { at: Date.now(), data, total });
    }
}

module.exports = { RESULT_CACHES, resultCacheLookup, resultCacheStore };
