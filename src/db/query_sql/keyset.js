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
 * XChain Explorer - API keyset paging (?before= / ?after=)
 *
 * One part of src/db/query_sql.js: an API list page addressed by its cursor
 * column instead of by ?page=. A deep OFFSET reads every skipped index entry
 * before the page, so page 101 costs a hundred pages; a bound on the cursor
 * reads one page from the index whatever its depth. The bound is the same
 * ` AND <cursor> < ?` predicate the explorer transport's next/prev paging
 * carries in sql.where.offset, so every listed reader already places and binds
 * it; getHistory builds its own WHERE and reads sql.keyset instead.
 *
 * Only lists that hold one row per cursor value are listed: where several
 * rows share an action_index (sends, destroys, credits, anchor sections) a
 * strict bound would skip the rest of a value split across a page edge, so
 * those keep ?page= alone.
 *
 * Plain functions, not a class body: they take the Database as `db` and
 * nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

const { cursorField } = require('./offset_cursors.js');
const { DbInputError } = require('../shared.js');

// Lists whose driving table is UNIQUE on action_index (or, for commitments, one
// row per height), checked against the indexer DDL.
const KEYSET_METHODS = new Set([
    'getHistory', 'getCommitments', 'getActions',
    'getAddresses', 'getBatches', 'getBetFeeds', 'getBets', 'getBroadcasts', 'getCallbacks',
    'getCoinpayExpires', 'getCoinpayObligations', 'getCoinpays', 'getContracts',
    'getDelegations', 'getDeposits', 'getDispensers', 'getDispenses', 'getDividends',
    'getExecutions', 'getFiles', 'getIssues', 'getLinks', 'getLists', 'getMessages',
    'getMints', 'getOrderCancels', 'getOrderEdits', 'getOrders', 'getPolls', 'getPrices',
    'getSleeps', 'getStakes', 'getSwapCancels', 'getSwapEdits', 'getSwaps', 'getSweeps',
    'getUnstakes', 'getWithdrawals'
]);

// The row field a page's next cursor is read from: the cursor column without its alias.
function keysetColumn(method){
    return cursorField(method).replace(/^\w+\./, '');
}

// The one keyset bound a request carries, or null. Refused with a 400 when the
// value is not a non-negative safe integer, when both bounds are given, or when
// the list has no keyset paging.
function requestedKeyset(db, method, q){
    let given = ['before', 'after'].filter((name) => q && q[name] !== undefined);
    if(!given.length)
        return null;
    if(given.length > 1)
        throw new DbInputError('Use before or after, not both', 'INVALID_CURSOR');
    let name = given[0];
    if(!KEYSET_METHODS.has(method))
        throw new DbInputError('This list does not page by ' + name, 'CURSOR_UNSUPPORTED');
    if(!db.util.isSafeIntegerParam(q[name]))
        throw new DbInputError('Invalid ' + name + ' cursor', 'INVALID_CURSOR');
    return { op: (name == 'before') ? '<' : '>', value: Number(q[name]) };
}

// Turn ?before=/?after= into the cursor predicate and drop the page's OFFSET, so
// page is ignored. Runs after apiPageOffset; the explorer transport never calls it.
function apiKeyset(db, config, q){
    let sql    = config.data.sql;
    let method = config.data.method;
    let keyset = requestedKeyset(db, method, q);
    if(KEYSET_METHODS.has(method))
        sql.keysetColumn = keysetColumn(method);
    if(!keyset)
        return;
    sql.keyset    = keyset;
    sql.apiOffset = 0;
    if(method == 'getHistory')
        return;
    sql.where.offset     = ' AND ' + cursorField(method) + ' ' + keyset.op + ' ?';
    sql.where.offsetArgs = [keyset.value];
}

// A keyset page reads the rows nearest its bound, walking away from it (before
// downward, after upward), so its continuation cursor never leaves the requested
// range; sortorder only decides how the page is shown (getData reverses it).
function keysetWalkOrder(sql, order){
    if(!sql.keyset)
        return order;
    let walk = (sql.keyset.op == '<') ? 'DESC' : 'ASC';
    sql.keysetReversed = (walk !== order);
    return walk;
}

module.exports = { KEYSET_METHODS, keysetColumn, apiKeyset, keysetWalkOrder };
