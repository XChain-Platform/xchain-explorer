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

const { expect } = require('chai');
const sharedLists = require('../../../../src/db/readers/action_lists/shared_lists.js');

const config = {
    coin: 'BTC',
    data: { sql: { apiOffset: 0, limit: 100 } }
};

function homeRow(index){
    return {
        kind: 'home', home_chain: 'BTC', home_list_index: index,
        local_list_index: index, type: 2, member_count: 0,
        share_block: 700, share_action_index: index + 1000, seq: null
    };
}

function mirrorRow(){
    return {
        kind: 'mirror', home_chain: 'DOGE', home_list_index: 202,
        local_list_index: 303, type: 2, member_count: 0,
        share_block: 800, share_action_index: null, seq: 1
    };
}

function missingTable(){
    let error = new Error("Table 'indexer.list_metas' doesn't exist");
    error.code = 'ER_NO_SUCH_TABLE';
    error.errno = 1146;
    return error;
}

function makeReader(options){
    options = options || {};
    let reader = Object.create(sharedLists);
    reader.calls = [];
    reader.getListOwnerAddresses = async () => ({});
    reader.doQuery = async (cfg, query, args) => {
        let sql = String(query).replace(/\s+/g, ' ');
        reader.calls.push({ sql, args });
        if(sql.includes("'home' AS kind")) return options.home || [];
        if(sql.includes('FROM list_share_mirrors mirror')) return options.mirrors || [];
        if(sql.includes('FROM list_metas m')){
            if(options.metaError) throw options.metaError;
            return (options.metas || []).filter(row => row.status !== 'invalid');
        }
        return [];
    };
    return reader;
}

describe('shared-list names', function () {
    it('reads home names in one batch and keeps the newest valid rename', async function () {
        const reader = makeReader({
            home: [homeRow(101), homeRow(102), homeRow(103)],
            metas: [
                { root: 101, action_index: 101, name: 'Named home' },
                { root: 102, action_index: 102, name: 'Original name' },
                { root: 102, action_index: 120, name: 'Newest valid name' }
            ]
        });
        const [rows] = await reader.getSharedLists(config);

        expect(rows.map(row => row.name)).to.deep.equal([
            'Named home', 'Newest valid name', null
        ]);
        const calls = reader.calls.filter(call => call.sql.includes('FROM list_metas m'));
        expect(calls).to.have.length(1);
        expect(calls[0].args).to.deep.equal([101, 102, 103]);
        expect(calls[0].sql).to.include("s.status='valid'");
        expect(calls[0].sql).to.include('ORDER BY m.action_index ASC');
    });

    it('ignores an invalid rename and reads a mirror name from its local list', async function () {
        const reader = makeReader({
            home: [homeRow(101)],
            mirrors: [mirrorRow()],
            metas: [
                { root: 101, action_index: 101, name: 'Still valid' },
                { root: 101, action_index: 130, name: 'Invalid rename', status: 'invalid' },
                { root: 303, action_index: 303, name: 'Local mirror name' }
            ]
        });
        const [rows] = await reader.getSharedLists(config);

        expect(rows.map(row => row.name)).to.deep.equal(['Still valid', 'Local mirror name']);
        const metaCall = reader.calls.find(call => call.sql.includes('FROM list_metas m'));
        expect(metaCall.args).to.deep.equal([101, 303]);
        expect(metaCall.args).not.to.include(202);
    });

    it('returns null names when list_metas is missing', async function () {
        const reader = makeReader({
            home: [homeRow(101)],
            mirrors: [mirrorRow()],
            metaError: missingTable()
        });
        const [rows] = await reader.getSharedLists(config);

        expect(rows.map(row => row.name)).to.deep.equal([null, null]);
    });

    it('does not hide another metadata query failure', async function () {
        const reader = makeReader({
            home: [homeRow(101)],
            metaError: new Error('metadata read failed')
        });

        let error = null;
        try {
            await reader.getSharedLists(config);
        } catch(e){
            error = e;
        }
        expect(error).to.be.an('error').with.property('message', 'metadata read failed');
    });
});
