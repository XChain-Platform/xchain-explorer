/*********************************************************************
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
 **********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const { DatabaseSync } = require('node:sqlite');
const { toSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const API_ROUTES = require('../../../../src/explorer/routes/api_methods.js').api;
const API_SPEC = require('../../../../src/content/json/xchain-platform-api.json');
const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

const util = {
    isNull: value => value === null || value === undefined,
    isNumeric: value => value !== null && value !== '' && Number.isFinite(Number(value)),
    isInteger: value => Number.isInteger(Number(value))
};
const explorer = {
    util,
    configInfo: { onConfigChanged: () => {} }
};
const config = {
    coin: 'BTC',
    data: { sql: { apiOffset: 0, limit: 100 } }
};
const TABLES = ['list_share_mirrors', 'lists', 'index_statuses', 'list_items',
    'bridge_settlements', 'list_snapshots'];
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');

function requireDdl() {
    for(const table of TABLES){
        const ddl = path.join(INDEXER_SQL_DIR, table + '.sql');
        const verdict = siblingCheckout(__dirname, ddl);
        if(!verdict.usable) return skipOrFail(this, verdict, 'the real indexer DDL shared-list fixture');
    }
}

function missingTable(table){
    table = table || 'list_share_mirrors';
    let driver = new Error("Table 'indexer." + table + "' doesn't exist");
    driver.code = 'ER_NO_SUCH_TABLE';
    driver.errno = 1146;
    let wrapped = new Error('database query failed');
    wrapped.cause = driver;
    return wrapped;
}

function sqliteDdl(table){
    const raw = fs.readFileSync(path.join(INDEXER_SQL_DIR, table + '.sql'), 'utf8');
    return toSqlite(raw)
        .replace(/^\s*(UNIQUE\s+)?KEY\s+\w+\s*\([^)]*\),?[^\n]*$/gim, '')
        .replace(/,([ \t]*--[^\n]*)?\s*\);/g, '$1\n);');
}

// The replica's own list_snapshots holds a decoy seq: sync never fills it, so the
// applied seq must come from the attached hub schema, scoped to the hub's network.
function mirrorFixture(){
    let fixture = new DatabaseSync(':memory:');
    for(const table of TABLES) fixture.exec(sqliteDdl(table));
    fixture.exec("ATTACH DATABASE ':memory:' AS hubdb");
    fixture.exec(sqliteDdl('list_snapshots').replace(/CREATE TABLE list_snapshots/, 'CREATE TABLE hubdb.list_snapshots'));
    fixture.exec(`
        INSERT INTO index_statuses (id, status) VALUES (1, 'valid');
        INSERT INTO list_share_mirrors (action_index, home_chain, home_list_index, block_index)
            VALUES (303, 'DOGE', 202, 800);
        INSERT INTO lists (action_index, list_action_index, type, status_id)
            VALUES (303, NULL, 2, 1), (304, 303, 2, 1);
        INSERT INTO list_items (action_index, item_id) VALUES (304, 1), (304, 2), (304, 3), (304, 4);
        INSERT INTO list_snapshots
            (snapshot_id, snapshot_block, seq, network, added, removed, validator_signatures)
            VALUES ('applied-9', 1, 99, 'mainnet', '[]', '[]', '[]');
        INSERT INTO hubdb.list_snapshots
            (snapshot_id, snapshot_block, seq, network, added, removed, validator_signatures)
            VALUES ('applied-1', 1, 1, 'mainnet', '[]', '[]', '[]'),
                   ('applied-9', 1, 9, 'mainnet', '[]', '[]', '[]'),
                   ('unapplied-12', 1, 12, 'mainnet', '[]', '[]', '[]'),
                   ('foreign-15', 1, 15, 'testnet', '[]', '[]', '[]');
        INSERT INTO bridge_settlements
            (action_index, transfer_id, kind, block_index, src_chain, src_action_index)
            VALUES (901, 'applied-1', 'list', 800, 'DOGE', 202),
                   (902, 'applied-9', 'list', 800, 'DOGE', 202),
                   (903, 'foreign-15', 'list', 800, 'DOGE', 202);`);
    return fixture;
}

function makeDb(options){
    let db = new Database(explorer);
    options = options || {};
    db.calls = [];
    db.checkpointDb = { BTC: { name: options.hubSchema || 'hubdb', chain: 'BTC', network: 'mainnet' } };
    if(options.noHub) db.checkpointDb = {};
    db.mirrorFixture = mirrorFixture();
    db.doQuery = async (cfg, query, args) => {
        let sql = String(query).replace(/\s+/g, ' ');
        db.calls.push({ sql, args });
        if(sql.includes('`nohub`.list_snapshots')) throw missingTable('list_snapshots');
        if(sql.includes("'home' AS kind")) return [{
            kind: 'home', home_chain: args[0], home_list_index: 101,
            local_list_index: 101, type: '2', member_count: 3,
            share_block: 700, share_action_index: 111, seq: null
        }];
        if(sql.includes('FROM list_share_mirrors mirror')){
            if(options.missingMirrors) throw missingTable();
            if(options.mirrorError) throw new Error('mirror read failed');
            return db.mirrorFixture.prepare(query).all(...args);
        }
        if(sql.includes('FROM list_metas m')){
            if(options.metas) return options.metas;
            throw missingTable('list_metas');
        }
        if(sql.includes('SELECT action_index, list_action_index FROM lists WHERE action_index IN'))
            return args.map(action_index => ({ action_index, list_action_index: null }));
        if(sql.includes('a2.address AS owner'))
            return [{ root: 101, owner: 'creator-address' }];
        if(sql.includes('FROM list_transfers t'))
            return [{ root: 101, owner: 'first-owner' }, { root: 101, owner: 'current-owner' }];
        return [];
    };
    return db;
}

const HOME = {
    kind: 'home',
    home_chain: 'BTC',
    home_list_index: 101,
    local_list_index: 101,
    type: 2,
    name: null,
    owner: 'current-owner',
    member_count: 3,
    share_block: 700,
    share_action_index: 111,
    seq: null
};

const MIRROR = {
    kind: 'mirror',
    home_chain: 'DOGE',
    home_list_index: 202,
    local_list_index: 303,
    type: 2,
    name: null,
    owner: null,
    member_count: 4,
    share_block: 800,
    share_action_index: null,
    seq: 9
};

async function returnsNewestNames(){
    const db = makeDb({ metas: [
        { root: 101, action_index: 101, name: 'Original home' },
        { root: 101, action_index: 120, name: 'Renamed home' },
        { root: 303, action_index: 303, name: 'Mirror name' }
    ] });
    const [rows] = await db.getSharedLists(config);
    expect(rows.map(row => row.name)).to.deep.equal(['Renamed home', 'Mirror name']);
    const metaCall = db.calls.find(call => call.sql.includes('FROM list_metas m'));
    expect(metaCall.args).to.deep.equal([101, 303]);
    expect(metaCall.sql).to.include("s.status='valid'");
}

async function returnsPublicShape(){
    const db = makeDb();
    const [rows, args, total] = await db.getSharedLists(config);
    expect(rows).to.deep.equal([HOME, MIRROR]);
    expect(args).to.equal(null);
    expect(total).to.equal(2);
    const homeSql = db.calls.find(call => call.sql.includes("'home' AS kind")).sql;
    expect(homeSql).to.include('share_action.action_format=2');
    expect(homeSql).to.include("share_status.status='valid'");
    expect(homeSql).to.include('MAX(head.action_index)');
    const mirrorCall = db.calls.find(call => call.sql.includes('FROM list_share_mirrors mirror'));
    const mirrorSql = mirrorCall.sql;
    expect(mirrorSql).to.include('SELECT MAX(snapshot.seq)');
    expect(mirrorSql).to.include('INNER JOIN `hubdb`.list_snapshots snapshot');
    expect(mirrorSql).to.include('snapshot.network=?');
    expect(mirrorCall.args).to.deep.equal(['mainnet']);
    expect(mirrorSql).to.include('snapshot.snapshot_id=settlement.transfer_id');
    expect(mirrorSql).not.to.include('SELECT COUNT(*) FROM bridge_settlements settlement');
    expect(db.mirrorFixture.prepare('SELECT COUNT(*) AS n FROM bridge_settlements').get().n).to.equal(3);
    expect(db.mirrorFixture.prepare('SELECT MAX(seq) AS seq FROM hubdb.list_snapshots').get().seq).to.equal(15);
}

async function omitsSeqWithoutHub(){
    const { seq, ...unknownSeq } = MIRROR;
    expect(seq).to.equal(9);
    for(const options of [{ noHub: true }, { hubSchema: 'nohub' }]){
        const [rows, , total] = await makeDb(options).getSharedLists(config);
        expect(rows, JSON.stringify(options)).to.deep.equal([HOME, unknownSeq]);
        expect(total).to.equal(2);
    }
}

describe('shared-list explorer route', function () {
    before(requireDdl);

    it('registers the no-query route against the composed reader', function () {
        expect(API_ROUTES['/{COIN}/api/shared_lists']).to.deep.equal(['getSharedLists']);
        expect(Database.prototype.getSharedLists).to.be.a('function');
        expect(API_SPEC.paths).to.have.property('/{COIN}/api/shared_lists');
    });

    it('returns home and mirror rows in the public shape', returnsPublicShape);

    it('omits a mirror\'s seq when the co-located hub cannot answer it', omitsSeqWithoutHub);

    it('puts the latest valid transfer owner in the LIST action state', async function () {
        const db = makeDb();
        db.isListEditResolutionActiveAtTip = async () => false;
        const state = await db.getListCurrentMembership({ coin: 'BTC' }, 101, 2);
        expect(state.owner).to.equal('current-owner');
        expect(state.current_list).to.equal(null);
    });

    it('keeps home rows when the mirror mapping table is absent', async function () {
        const [rows, args, total] = await makeDb({ missingMirrors: true }).getSharedLists(config);
        expect(rows).to.deep.equal([HOME]);
        expect(args).to.equal(null);
        expect(total).to.equal(1);
    });

    it('returns the newest valid name for each local shared list', returnsNewestNames);

    it('does not hide a mirror query failure that is not a missing table', async function () {
        let error = null;
        try {
            await makeDb({ mirrorError: true }).getSharedLists(config);
        } catch(e){
            error = e;
        }
        expect(error).to.be.an('error').with.property('message', 'mirror read failed');
    });
});
