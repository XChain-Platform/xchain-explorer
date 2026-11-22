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
 * Shared harness for the wallet range read suites: an explorer built with the
 * REAL Database class whose doQuery runs on an in-memory SQLite copy of the
 * indexer's real DDL (plus a hub-mirror price_snapshots in an attached schema),
 * the registered route handlers, and a driver that records every statement.
 *
 *********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const proxyquire = require('proxyquire');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { mockRes } = require('../../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite, toSqlite } = require('../../../../helpers/indexer_ddl_sqlite.js');
const { base58check } = require('../../request/address_shape.test/support/address_encode.js');

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');

const TABLES = ['actions', 'blocks', 'transactions', 'index_actions', 'index_transactions', 'mappings_actions',
    'batches', 'credits', 'debits', 'index_addresses', 'index_tickers', 'tokens', 'index_statuses', 'index_coins', 'orders'];

// Tables whose DDL carries an ENUM, which the shared translation does not handle.
const ENUM_TABLES = [['order_matches', null], ['price_snapshots', 'hubdb']];

const HUB_SCHEMA = 'hubdb';
const COIN = 'BTC';

const ADDRESSES = Array.from({ length: 20 }, (_, i) => base58check(0, Buffer.alloc(20, i + 1)));
const OUTSIDER  = base58check(0, Buffer.alloc(20, 99));

// Express double recording registrations, so a suite drives the real handlers.
const registrations = { get: [], post: [] };
const mockApp = {
    use:    () => {},
    enable: () => {},
    get:    (route, ...handlers) => { registrations.get.push({ route, handlers }); },
    post:   (route, ...handlers) => { registrations.post.push({ route, handlers }); }
};
const expressMock  = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const XChainExplorer = proxyquire('../../../../../src/XChainExplorer.js', {
    'express': expressMock,
    './db/index.js': Database
});

// An ENUM table's real DDL, translated like the rest plus ENUM as TEXT; a schema
// name attaches it the way the co-located hub DB qualifies price_snapshots.
function createEnumTable(sqlite, table, schema){
    const raw = fs.readFileSync(path.join(INDEXER_SQL_DIR, table + '.sql'), 'utf8');
    let lite = toSqlite(raw.replace(/^\s*--[^\n]*\n/gm, '').replace(/^\s*UNIQUE KEY[^\n]*\n/gm, ''))
        .replace(/BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY/, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/ENUM\([^)]*\)/g, 'TEXT');
    if(schema){
        sqlite.exec('ATTACH DATABASE \':memory:\' AS ' + schema + ';');
        lite = lite.replace('CREATE TABLE ' + table, 'CREATE TABLE ' + schema + '.' + table);
    }
    sqlite.exec(lite);
}

function openWalletTables(ctx){
    const sqlite = openIndexerTables(ctx, TABLES);
    if(sqlite)
        for(const [table, schema] of ENUM_TABLES) createEnumTable(sqlite, table, schema);
    return sqlite;
}

function clearTables(sqlite){
    for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
    for(const [table, schema] of ENUM_TABLES) sqlite.exec('DELETE FROM ' + (schema ? schema + '.' : '') + table + ';');
}

/**
 * Build an explorer over `sqlite`. Every statement doQuery receives is pushed
 * onto the returned `seen` array, so a suite can count them per request.
 */
function buildExplorer(sqlite, { stale = false, failClosed = false, hub = true } = {}){
    registrations.get.length  = 0;
    registrations.post.length = 0;
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    const seen = [];
    explorer.db.pools = { [COIN]: { pool: {} } };
    explorer.db.checkpointDb = hub ? { [COIN]: { name: HUB_SCHEMA } } : {};
    sinon.stub(explorer.db, 'doQuery').callsFake(async (c, q, a) => { seen.push(q); return runOnSqlite(sqlite, q, a); });
    sinon.stub(explorer.db, 'getCoinFreshness').resolves({ stale, tip_block: 119, tip_age_seconds: 30, replica_halted: false });
    sinon.stub(explorer.db, 'staleFailClosed').returns(failClosed);
    return { explorer, seen };
}

function routeHandler(verb, route){
    const found = registrations[verb].find((r) => r.route === route);
    if(!found) throw new Error('no ' + verb.toUpperCase() + ' registration for ' + route);
    return found.handlers[found.handlers.length - 1];
}

/** Drive a registered handler and wait for its response: { code, body, headers }. */
async function drive(handler, req){
    const res = mockRes();
    handler(Object.assign({ params: { coin: COIN }, query: {}, body: {} }, req), res);
    for(let i = 0; i < 5000 && res._body === null; i++)
        await new Promise((resolve) => setImmediate(resolve));
    if(res._body === null) throw new Error('the route never sent a response');
    return { code: res._status, body: JSON.parse(res._body), headers: res._headers };
}

function insert(sqlite, table, row){
    const cols = Object.keys(row);
    const sql  = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
    return Number(sqlite.prepare(sql).run(...cols.map((c) => row[c])).lastInsertRowid);
}

module.exports = { ADDRESSES, OUTSIDER, COIN, HUB_SCHEMA, openWalletTables, clearTables, buildExplorer, routeHandler, drive, insert };
