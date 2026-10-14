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
 * One part of src/db/query_sql.js: the checks and clamps getQuery puts on the two
 * paged transports before any SQL is built. The API transport pages by SQL OFFSET,
 * the explorer transport by cursor (with a fetch-and-slice fallback for the lists
 * that have no unique cursor column), so each has its own ceiling.
 *
 * Every number here is raw query-string input. A malformed one answers 400 with a
 * stable code rather than reaching SQL, and each clamp keeps one request from
 * handing MariaDB a full-table scan for a single page.
 *
 * Plain functions, not a class body: they take the Database as `db` and nothing
 * here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

const { DbInputError } = require('../shared.js');
const { SLICE_PAGED_METHODS, MULTI_ROW_METHODS } = require('../method_tables.js');

// The deepest row either transport reaches by position; deeper pages use a cursor.
const OFFSET_CAP = 100000;

// Explorer lists whose paging cannot run backwards, so prev and last read forwards.
const FORWARD_ONLY_METHODS = ['getHolders', 'getBalances', ...MULTI_ROW_METHODS];

/**
 * Read one paging integer from the query string, refusing a malformed one.
 *
 * @param {object} db the Database (for its util)
 * @param {object|boolean} q the parsed query string, or false
 * @param {string} name the parameter name
 * @param {number} fallback the value when the parameter is absent or empty
 * @param {number} min the smallest value accepted
 * @param {string} code the error code a malformed value answers with
 * @returns {number} the parameter as a safe integer
 */
function queryInteger(db, q, name, fallback, min, code){
    let raw = q ? q[name] : undefined;
    if(raw === undefined || raw === null || raw === '')
        return fallback;
    if(!db.util.isSafeIntegerParam(raw) || Number(raw) < min)
        throw new DbInputError('Invalid ' + name, code);
    return Number(raw);
}

// The sort order a request asked for: asc or desc in any case, else a 400.
function querySortOrder(db, q, fallback){
    let raw = q ? q.sortorder : undefined;
    if(raw === undefined || raw === null || raw === '')
        return fallback;
    let order = (typeof raw === 'string') ? raw.toUpperCase() : '';
    if(!['ASC', 'DESC'].includes(order))
        throw new DbInputError('Invalid sortorder', 'INVALID_SORTORDER');
    return order;
}

// The API page size: the method max when absent, clamped to it when larger.
function apiLimit(db, q, max){
    return Math.min(queryInteger(db, q, 'limit', max, 1, 'INVALID_LIMIT'), max);
}

function apiPageOffset(db, config, q, limit){
    let page   = queryInteger(db, q, 'page', 1, 1, 'INVALID_PAGE');
    let offset = (page - 1) * limit;
    // A keyset bound replaces the page, so only a positional page is held to the cap.
    let keyset = Boolean(q) && [q.before, q.after].some((v) => v !== undefined);
    if(offset > OFFSET_CAP && !keyset)
        throw new DbInputError('page is beyond the deepest page served by position (' + OFFSET_CAP
            + ' rows); page by before/after where the list offers them', 'PAGE_TOO_DEEP');
    config.data.sql.apiOffset = keyset ? 0 : offset;
}

// The explorer transport's page size and order, clamped against the method's max.
function explorerLimits(db, config, q, max, limit, order){
    let data   = config.data;
    let action = (q.action) ? q.action : false;
    // An unusable start reads the first page, as the page window does; only a whole
    // number can reach LIMIT.
    let start  = Number(q.start);
    if(!Number.isSafeInteger(start) || start < 0) start = 0;
    let length = Math.min(queryInteger(db, q, 'length', 10, 1, 'INVALID_LENGTH'), max);
    if(FORWARD_ONLY_METHODS.includes(data.method) && ['prev','last'].includes(action))
        config.data.query.action = config.data.offset.action = action = 'next';
    let sliced = SLICE_PAGED_METHODS.includes(data.method) ||
        (data.method=='getTokens' && ['token','subtoken'].includes(data.type));
    // The cursor a next/prev page continues from (empty on first and last). A list
    // paged by row position never reads it, whatever its rows' last cell holds.
    if(!sliced && q.offset && !db.util.isSafeIntegerParam(q.offset))
        throw new DbInputError('Invalid offset', 'INVALID_OFFSET');
    limit = length;
    // Size the jump-to-last page from the client's record total, within one page of
    // rows; an unusable or fractional total keeps the page length.
    if(action=='last'){
        let tail = Number(config.data.query.total) - start;
        if(Number.isSafeInteger(tail))
            limit = Math.max(1, Math.min(tail, max));
    }
    // Row-position lists fetch start+length rows and keep the window, with the
    // offset fed to LIMIT capped so one request cannot force an unbounded scan.
    if(sliced)
        limit = db.util.bcadd(Math.min(start, OFFSET_CAP), length);
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

// The direction a multi-leg action's legs are read in. The explorer shows a prev or
// last page reversed, so its legs are read backwards to land in wire order.
function legOrder(config){
    let action = config.data.offset && config.data.offset.action;
    return (config.type=='explorer' && ['prev','last'].includes(action)) ? 'DESC' : 'ASC';
}

module.exports = { OFFSET_CAP, legOrder, queryInteger, querySortOrder, apiLimit, apiPageOffset,
    explorerLimits, explorerOffsets };
