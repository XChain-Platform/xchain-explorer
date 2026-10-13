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
 * XChain Explorer - the indexed address and block lanes of the action lists
 *
 * One part of src/db/query_sql.js, shared by the generic and the vote clause
 * builders. Filtering an action list on `a2.address=?` or `b1.block_index=?`
 * names the column through a join the index cannot follow, so MariaDB scans
 * the whole family table. These lanes name the indexed `actions` column the
 * join resolves to instead, for exactly the readers whose join makes the two
 * forms select the same rows.
 *
 * Plain functions: the clause builders take `config` alone, and the one
 * lookup takes the Database as `db` for doQuery.
 *
 ********************************************************************/

'use strict';

// Readers whose source address is the action's own source, falling back to
// its transaction's: their a2 join is ON (a2.id=COALESCE(a1.source_id,
// t1.source_id)) in both the row and the count query. getCoinpays carries the
// same join under a3 and getCoinpayExpires has no address join at all; the
// predicate below names neither alias, so it serves them as well.
const ACTION_SOURCE_METHODS = new Set([
    'getAddresses', 'getAirdrops', 'getAttestations', 'getBatches', 'getBetCancels', 'getBetEdits',
    'getBetExpires', 'getBetFeeds', 'getBetResolves',
    'getBets', 'getBroadcasts', 'getCallbacks', 'getCoinpayExpires', 'getCoinpays',
    'getContracts', 'getDestroys', 'getDispenserCancels', 'getDispenserEdits',
    'getDispenserExpires', 'getDispensers', 'getDividends', 'getFiles', 'getIssues',
    'getLinks', 'getLists', 'getMessages', 'getMints', 'getOrderCancels',
    'getOrderEdits', 'getOrderExpires', 'getPolls', 'getRollcalls', 'getSends', 'getSleeps',
    'getSwapCancels', 'getSwapEdits', 'getSwapExpires', 'getSwaps', 'getSweeps',
    'getVotes'
]);

// Methods whose address lane matches either party, (a2.address=? OR
// a3.address=?). The OR spans two tables, which no single index serves, so
// these keep that form; their source lane is single-party and takes the
// indexed predicate.
const TWO_PARTY_ADDRESS_METHODS = new Set([
    'getMessages', 'getMints', 'getOrders', 'getSends', 'getSweeps',
    'getDispensers', 'getDispenses'
]);

// Readers that reach blocks through the action's own block: their b1 join is
// ON (b1.block_index=a1.block_index) in both the row and the count query, so
// a1.block_index=? selects the same rows and lets actions.block_index drive.
const ACTION_BLOCK_METHODS = new Set([
    'getAirdrops', 'getAttestations', 'getBroadcasts', 'getCallbacks',
    'getCoinpayExpires', 'getCoinpays', 'getCollectibles',
    'getDestroys', 'getDispenserCloses', 'getDispenserExpires', 'getDispensers',
    'getDividends', 'getExecutions', 'getFees', 'getFiles',
    'getIssues', 'getLinks', 'getLists', 'getMessages', 'getMints',
    'getOrderExpires', 'getOrderMatches', 'getOrders', 'getPolls', 'getSends',
    'getSwapExpires', 'getSwapMatches', 'getSweeps', 'getTokens', 'getUnstakes',
    'getVotes', 'getXcalls'
]);

// The same row set as COALESCE(a1.source_id, t1.source_id)=id, written so the
// source_id index on actions can serve it: an action that names its own
// source matches on that, and only an action with none falls back to its
// transaction's. Both placeholders bind the resolved address id.
const ACTION_SOURCE_SQL = ' AND (a1.source_id=? OR (a1.source_id IS NULL AND t1.source_id=?))';

const ADDRESS_ID_SQL = `SELECT id FROM index_addresses WHERE address=? LIMIT 1`;

function usesActionSource(config){
    let { method, type } = config.data;
    if(!ACTION_SOURCE_METHODS.has(method))
        return false;
    if(type=='source')
        return true;
    return type=='address' && !TWO_PARTY_ADDRESS_METHODS.has(method);
}

// The single-party address predicate for this request.
function sourceAddressClause(config){
    return usesActionSource(config) ? ACTION_SOURCE_SQL : ' AND a2.address=?';
}

// The block predicate for this request.
function blockClause(config){
    return ACTION_BLOCK_METHODS.has(config.data.method)
        ? ' AND a1.block_index=?'
        : ' AND b1.block_index=?';
}

// The binds follow the predicate text, so a builder that did not emit it never
// leaves a second bind behind. Building the SQL only records the address to
// resolve; resolveActionSource looks it up once when the query runs, so a
// caller that only builds SQL needs no database. An unknown address binds NULL,
// which matches no row, so the list and its count answer empty rather than
// failing.
function markActionSource(config, sql){
    let where = config.data.sql && config.data.sql.where;
    if(!where)
        return;
    delete where.dataArgs;
    delete where.actionSourceAddress;
    if(String(sql).includes(ACTION_SOURCE_SQL))
        where.actionSourceAddress = config.data.search;
}

async function resolveActionSource(db, config){
    let where = config.data.sql && config.data.sql.where;
    if(!where || !Object.prototype.hasOwnProperty.call(where, 'actionSourceAddress'))
        return;
    let rows = await db.doQuery(config, ADDRESS_ID_SQL, [where.actionSourceAddress]);
    let id   = (rows && rows.length) ? Number(rows[0].id) : null;
    delete where.actionSourceAddress;
    where.dataArgs = [id, id];
}

// Marks and resolves in one step, for a caller that builds and runs at once.
async function bindActionSource(db, config, sql){
    markActionSource(config, sql);
    await resolveActionSource(db, config);
}

module.exports = { ACTION_SOURCE_METHODS, TWO_PARTY_ADDRESS_METHODS, ACTION_BLOCK_METHODS,
    ACTION_SOURCE_SQL, usesActionSource, sourceAddressClause, blockClause, markActionSource, resolveActionSource, bindActionSource };
