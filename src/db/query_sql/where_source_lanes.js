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
 * forms select the same rows. The two-party address lists match either party,
 * and drive from a UNION of indexed id sets instead of an OR across two joins.
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

// Methods whose address lane matches either party: the a2 source join or the
// a3 counterparty join, named here by the family table and the column a3
// joins on. An OR across the two joins is served by no index, so the lane
// below drives from an indexed id set instead; their source lane is
// single-party and takes the indexed predicate.
const TWO_PARTY_COUNTERPARTS = {
    getMessages:   ['messages',   'destination_id'],
    getMints:      ['mints',      'destination_id'],
    getOrders:     ['orders',     'get_address_id'],
    getSends:      ['sends',      'destination_id'],
    getSweeps:     ['sweeps',     'destination_id'],
    getDispensers: ['dispensers', 'get_address_id'],
    getDispenses:  ['dispenses',  'destination_id']
};
const TWO_PARTY_ADDRESS_METHODS = new Set(Object.keys(TWO_PARTY_COUNTERPARTS));

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

// The actions of one two-party family the address takes part in, each side
// through its own index: actions.source_id, then transactions.source_id for an
// action with no source of its own, then the counterparty column. getDispenses
// takes its a2 side from the dispenser it fills (d1.get_address_id), so its
// source side is that dispenser's address. MariaDB will not semi-join an IN
// over a UNION, so the UNION sits in a derived table under a plain SELECT,
// which it can materialize once and join on m.action_index. The p* aliases
// stay clear of every alias the readers and their SQL rewrites use.
function twoPartyIdSetSql(method){
    let [table, column] = TWO_PARTY_COUNTERPARTS[method];
    let sourceSide = (method=='getDispenses')
        ? `SELECT px.action_index FROM dispenses px
                INNER JOIN dispensers pd ON (pd.action_index=px.dispenser_action_index)
                WHERE pd.get_address_id=?`
        : `SELECT px.action_index FROM ${table} px
                INNER JOIN actions pa ON (pa.action_index=px.action_index)
                WHERE pa.source_id=?
            UNION
            SELECT px.action_index FROM ${table} px
                INNER JOIN actions pa ON (pa.action_index=px.action_index)
                INNER JOIN transactions pt ON (pt.tx_index=pa.tx_index)
                WHERE pa.source_id IS NULL AND pt.source_id=?`;
    return ` AND m.action_index IN (SELECT pu.action_index FROM (
            ${sourceSide}
            UNION
            SELECT px.action_index FROM ${table} px WHERE px.${column}=?
        ) pu)`;
}

// The id set narrows to whole actions; the row test after it keeps the
// per-row match, which differs from the action match only where one action
// has several rows: a multi-send lists just the legs paid to an address that
// is not its source.
// The boundary queries page on action_index alone, so they take the id set
// without the row test, whose d1 join they do not carry.
function twoPartyRowSql(method){
    if(method=='getDispenses')
        return ' AND (d1.get_address_id=? OR m.destination_id=?)';
    let column = TWO_PARTY_COUNTERPARTS[method][1];
    return ` AND (a1.source_id=? OR (a1.source_id IS NULL AND t1.source_id=?) OR m.${column}=?)`;
}

const TWO_PARTY_ADDRESS_SQL  = {};
const TWO_PARTY_BOUNDARY_SQL = {};
for(let method of TWO_PARTY_ADDRESS_METHODS){
    TWO_PARTY_BOUNDARY_SQL[method] = twoPartyIdSetSql(method);
    TWO_PARTY_ADDRESS_SQL[method]  = twoPartyIdSetSql(method) + twoPartyRowSql(method);
}

function placeholderCount(sql){
    return (String(sql).match(/\?/g) || []).length;
}

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

// The two-party address lane for this request.
function twoPartyAddressClause(config){
    return TWO_PARTY_ADDRESS_SQL[config.data.method];
}

// How many times the resolved id binds: once per placeholder of whichever
// indexed lane the predicate text carries, or none.
function laneBinds(config, sql){
    let text = String(sql);
    let twoParty = TWO_PARTY_ADDRESS_METHODS.has(config.data.method) && TWO_PARTY_ADDRESS_SQL[config.data.method];
    if(twoParty && text.includes(twoParty))
        return placeholderCount(twoParty);
    return text.includes(ACTION_SOURCE_SQL) ? placeholderCount(ACTION_SOURCE_SQL) : 0;
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
    delete where.actionSourceBinds;
    let binds = laneBinds(config, sql);
    if(binds){
        where.actionSourceAddress = config.data.search;
        where.actionSourceBinds   = binds;
    }
}

async function resolveActionSource(db, config){
    let where = config.data.sql && config.data.sql.where;
    if(!where || !Object.prototype.hasOwnProperty.call(where, 'actionSourceAddress'))
        return;
    let rows  = await db.doQuery(config, ADDRESS_ID_SQL, [where.actionSourceAddress]);
    let id    = (rows && rows.length) ? Number(rows[0].id) : null;
    let binds = where.actionSourceBinds || placeholderCount(ACTION_SOURCE_SQL);
    delete where.actionSourceAddress;
    delete where.actionSourceBinds;
    where.dataArgs = new Array(binds).fill(id);
}

// Marks and resolves in one step, for a caller that builds and runs at once.
async function bindActionSource(db, config, sql){
    markActionSource(config, sql);
    await resolveActionSource(db, config);
}

module.exports = { ACTION_SOURCE_METHODS, TWO_PARTY_ADDRESS_METHODS, ACTION_BLOCK_METHODS,
    ACTION_SOURCE_SQL, TWO_PARTY_ADDRESS_SQL, TWO_PARTY_BOUNDARY_SQL, usesActionSource, sourceAddressClause,
    twoPartyAddressClause, placeholderCount, blockClause, markActionSource, resolveActionSource, bindActionSource };
