/*********************************************************************
 *
 * GENERATED
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
 **********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');

const API_ROUTES = require('../../../src/explorer/routes/api_methods.js').api;
const API_SPEC = require('../../../src/content/json/xchain-platform-api.json');
const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', {
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

function missingTable(){
    let driver = new Error("Table 'indexer.list_share_mirrors' doesn't exist");
    driver.code = 'ER_NO_SUCH_TABLE';
    driver.errno = 1146;
    let wrapped = new Error('database query failed');
    wrapped.cause = driver;
    return wrapped;
}

function makeDb(options){
    let db = new Database(explorer);
    options = options || {};
    db.calls = [];
    db.doQuery = async (cfg, query, args) => {
        let sql = String(query).replace(/\s+/g, ' ');
        db.calls.push({ sql, args });
        if(sql.includes("'home' AS kind")) return [{
            kind: 'home', home_chain: args[0], home_list_index: 101,
            local_list_index: 101, type: '2', member_count: 3,
            share_block: 700, share_action_index: 111, seq: null
        }];
        if(sql.includes('FROM list_share_mirrors mirror')){
            if(options.missingMirrors) throw missingTable();
            if(options.mirrorError) throw new Error('mirror read failed');
            return [{
                kind: 'mirror', home_chain: 'DOGE', home_list_index: 202,
                local_list_index: 303, type: 2, member_count: 4,
                share_block: 800, share_action_index: null, seq: 5
            }];
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
    owner: null,
    member_count: 4,
    share_block: 800,
    share_action_index: null,
    seq: 5
};

describe('shared-list explorer route', function () {
    it('registers the no-query route against the composed reader', function () {
        expect(API_ROUTES['/{COIN}/api/shared_lists']).to.deep.equal(['getSharedLists']);
        expect(Database.prototype.getSharedLists).to.be.a('function');
        expect(API_SPEC.paths).to.have.property('/{COIN}/api/shared_lists');
    });

    it('returns home and mirror rows in the public shape', async function () {
        const db = makeDb();
        const [rows, args, total] = await db.getSharedLists(config);
        expect(rows).to.deep.equal([HOME, MIRROR]);
        expect(args).to.equal(null);
        expect(total).to.equal(2);
        const homeSql = db.calls.find(call => call.sql.includes("'home' AS kind")).sql;
        expect(homeSql).to.include('share_action.action_format=2');
        expect(homeSql).to.include("share_status.status='valid'");
        expect(homeSql).to.include('MAX(head.action_index)');
    });

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
