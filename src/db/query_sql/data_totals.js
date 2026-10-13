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
 * XChain Explorer - the list total, counted once per tip
 *
 * One part of src/db/query_sql.js: the count step runListQuery hands its COUNT
 * to. A list page is a sub-millisecond index walk, but its `total` is a COUNT
 * over the whole filtered table, which every page request (next and last
 * included) would otherwise pay for again. The total of a list over indexer tables
 * moves only when the indexer applies a block (it writes each block inside one
 * transaction), so it is cached here under the coin's indexed tip and reorg
 * generation, the same two keys the getData result cache uses. The key's
 * filter part is the final COUNT text plus its bind arguments, so two requests
 * share an entry exactly when they would have run the same statement.
 *
 * Plain functions, not a class body: they take the Database as `db` (the cache
 * maps are per-instance fields created on first use).
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { pruneCountJoins } = require('./count_joins.js');

// The list methods whose COUNT reads only indexer tables written inside a block
// transaction: every action-list reader plus the raw action feed. Their COUNT is
// also pruned of display-only joins (see count_joins.js).
const TIP_TOTAL_METHODS = new Set([
    'getActions', 'getHistory',
    'getAddresses', 'getAirdrops', 'getBatches', 'getBroadcasts', 'getCallbacks',
    'getCoinpays', 'getCoinpayExpires', 'getCoinpayObligations', 'getCollectibles',
    'getDestroys', 'getDispensers', 'getDispenserCancels', 'getDispenserCloses',
    'getDispenserEdits', 'getDispenserExpires', 'getDispenses', 'getDividends',
    'getFees', 'getFiles', 'getIssues', 'getLinks', 'getLists', 'getMessages',
    'getMints', 'getOrders', 'getOrderCancels', 'getOrderEdits', 'getOrderExpires',
    'getOrderMatches', 'getSends', 'getSharedLists', 'getSleeps', 'getSwaps',
    'getSwapCancels', 'getSwapEdits', 'getSwapExpires', 'getSwapMatches',
    'getSweeps', 'getTokens'
]);

// Lists over hub-mirrored tables. The hub writes these on its own round clock
// and restamps rows in place, so the coin tip does not bound their freshness;
// the short TTL alone does.
const MIRROR_TOTAL_METHODS = new Set(['getPriceSnapshots']);

const DEFAULT_TIP_TTL_MS    = 60000;
const DEFAULT_MIRROR_TTL_MS = 15000;
const DEFAULT_MAX_ENTRIES   = 1000;

function envInt(db, name, fallback){
    const value = parseInt(db.configInfo.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function totalsTtl(db, method){
    return MIRROR_TOTAL_METHODS.has(method)
        ? envInt(db, 'EXPLORER_MIRROR_TOTALS_CACHE_MS', DEFAULT_MIRROR_TTL_MS)
        : envInt(db, 'EXPLORER_LIST_TOTALS_CACHE_MS', DEFAULT_TIP_TTL_MS);
}

async function runCount(db, config, count, args){
    const rows = await db.doQuery(config, count, args);
    return (rows) ? Number(rows[0].total) : 0;
}

function totalsKey(db, config, gen, count, args){
    const filter = crypto.createHash('sha256')
        .update(count + '\u0000' + JSON.stringify(args, (k, v) => typeof v === 'bigint' ? v.toString() : v))
        .digest('hex');
    return [config.coin, db._reorgGen[config.coin] || 0, gen, config.data.method, filter].join('|');
}

// Writes one total, evicting the oldest entry once the map is full.
function storeTotal(db, key, total){
    const max = envInt(db, 'EXPLORER_LIST_TOTALS_CACHE_MAX', DEFAULT_MAX_ENTRIES);
    if(db._listTotalsCache.size >= max)
        db._listTotalsCache.delete(db._listTotalsCache.keys().next().value);
    db._listTotalsCache.set(key, { at: Date.now(), total });
}

// Runs the COUNT once for every caller waiting on the same key, caches the
// answer, and lets a failure reach every waiter without being cached.
async function loadTotal(db, config, key, count, args){
    const active = db._listTotalsLoads.get(key);
    if(active) return active;
    const promise = runCount(db, config, count, args);
    db._listTotalsLoads.set(key, promise);
    try {
        const total = await promise;
        storeTotal(db, key, total);
        return total;
    } finally {
        if(db._listTotalsLoads.get(key) === promise)
            db._listTotalsLoads.delete(key);
    }
}

// The list total for this request: a cached one at an unchanged tip, else the
// (pruned) COUNT run once. Methods outside both sets run their COUNT as built.
// A failed tip probe (null generation) skips the cache entirely for the request,
// as resultCacheLookup does.
async function countTotal(db, config, count, args){
    const method = config.data.method;
    const tipBound = TIP_TOTAL_METHODS.has(method);
    if(!tipBound && !MIRROR_TOTAL_METHODS.has(method))
        return runCount(db, config, count, args);
    const sql = tipBound ? pruneCountJoins(count) : count;
    const gen = await db.resultCacheGeneration(config);
    if(gen === null)
        return runCount(db, config, sql, args);
    if(!db._listTotalsCache) db._listTotalsCache = new Map();
    if(!db._listTotalsLoads) db._listTotalsLoads = new Map();
    const key = totalsKey(db, config, gen, sql, args);
    const hit = db._listTotalsCache.get(key);
    if(hit && (Date.now() - hit.at) < totalsTtl(db, method))
        return hit.total;
    return loadTotal(db, config, key, sql, args);
}

module.exports = { TIP_TOTAL_METHODS, MIRROR_TOTAL_METHODS, countTotal };
