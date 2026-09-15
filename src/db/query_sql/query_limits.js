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
 * XChain Explorer - what a caller may ask a list for
 *
 * One part of src/db/query_sql.js: the clamps getQuery puts on the two paged
 * transports before any SQL is built. The API transport pages by SQL OFFSET, the
 * explorer transport by cursor (with a fetch-and-slice fallback for the searches
 * that have no cursor column), so each has its own ceiling.
 *
 * Every number here is raw query-string input, and each clamp below exists
 * because an unclamped one either emitted a rejected statement (LIMIT NaN, a 500
 * on an unauthenticated read route) or handed MariaDB a full-table scan for a
 * single page (query-complexity DoS).
 *
 * Plain functions, not a class body: they take the Database as `db` and nothing
 * here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

function apiPageOffset(db, config, q, limit){
    // Use SQL OFFSET for pagination instead of fetching all preceding pages
    let page  = (q && q.page  && db.util.isInteger(Number(q.page)))  ? q.page  : 1;
    page = Math.max(1, Number(page));
    // Cap the API OFFSET the same way the explorer fetch-and-slice path caps
    // `start` (see the 100k ceiling in the explorer branch below). An uncapped
    // OFFSET lets an unauthenticated request with a huge `page` force MariaDB to
    // join/order/skip a full-table row set for a single zero-row page
    // (query-complexity DoS); the list routes are multi-table joins. Deep
    // browsing uses the cursor next/prev path, so a 100k ceiling is invisible
    // to legitimate use while killing the scan blow-up.
    config.data.sql.apiOffset = Math.min((page - 1) * limit, 100000);
}

// The explorer transport's page size and order, clamped against the method's max.
function explorerLimits(db, config, q, max, limit, order){
    let data   = config.data;
    let start  = (q.start) ? q.start : 0;
    let length = (q.length) ? q.length : 10;
    let action = (q.action) ? q.action : false;
    // Same Number.isFinite fallback `length` and `total` already carry, and for
    // the same reason: a non-numeric or repeated `?start=` is NaN, Math.max(0,NaN)
    // is NaN, and the fetch-and-slice branch below concatenates it into the LIMIT
    // clause as `LIMIT NaN` (a rejected query, so 5xx on an unauthenticated read
    // route). Fall back to 0, not to the 100000 ceiling: the row slice reads the
    // RAW query.start, so a page fetched for an unusable start is discarded anyway.
    start  = Number(start);
    if(!Number.isFinite(start)) start = 0;
    start  = Math.max(0, start);
    if(!Number.isFinite(Number(length))) length = 10;
    length = Math.max(1, Math.min(Number(length), max));
    if(['getHolders','getBalances'].includes(data.method) && ['prev','last'].includes(action))
        config.data.query.action = config.data.offset.action = action = 'next';
    limit = length;
    if(limit > max)
        limit = max;
    // Size the jump-to-last page from the client's own record total, but clamp
    // it to the same per-method max the branches above enforce. `total` and
    // `start` are raw query-string input, so without the clamp
    // `?action=last&total=1e15` reached the LIMIT clause verbatim (full-table
    // scan on an unauthenticated list route) and a missing, non-numeric, or
    // repeated `total` emitted `LIMIT NaN` as a 500. A real last page never
    // exceeds one page of rows, so the ceiling is invisible to the UI; an
    // unusable total falls back to the already-clamped page length.
    if(action=='last'){
        let tail = Number(config.data.query.total) - Number(start);
        if(Number.isFinite(tail))
            limit = Math.max(1, Math.min(tail, max));
    }
    // token/subtoken/roster searches paginate by fetch-and-slice (no action_index offsets),
    // so the SQL limit must cover start+length rows. Cap the offset fed to the
    // SQL LIMIT: without a bound, an unauthenticated request with a huge `start`
    // forces MariaDB to scan start+length rows for a single page (query-complexity
    // DoS). Deep browsing uses the cursor next/prev path, not raw offsets, so a
    // 100k ceiling is invisible to legitimate use while killing the scan blow-up.
    if(['getBalances', 'getHolders','getSearch','getProjectTokens'].includes(data.method) ||
        (data.method=='getTokens' && ['token','subtoken'].includes(data.type)))
        limit = db.util.bcadd(Math.min(start, 100000), length);
    if(['prev','last'].includes(action))
        order = 'ASC';
    return { limit, order };
}

// Resolve the page's cursor bounds and the predicate that carries them, and hang
// both on the config the readers build their SQL from.
async function explorerOffsets(db, config, q, limit){
    let offset = (q.offset) ? q.offset : false;
    let [offset1, offset2] = await db.getQueryOffsets(config, offset, limit);
    config.data.offset.start = offset1;
    config.data.offset.stop  = offset2;
    let [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
    config.data.sql.where.offset     = offsetSql;
    config.data.sql.where.offsetArgs = offsetArgs;
}

module.exports = { apiPageOffset, explorerLimits, explorerOffsets };
