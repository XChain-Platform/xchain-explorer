/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *********************************************************************/

'use strict';

const assert = require('assert');
const listReaders = require('../../../../src/db/readers/action_detail_io/lists.js');
const blockReaders = require('../../../../src/db/readers/entities/blocks.js');
const networkReaders = require('../../../../src/db/readers/entities/network.js');
const queryOffsets = require('../../../../src/db/query_sql/offsets.js');
const { ACTION_TABLES, buildListsQuery } = require('../../../../src/db/method_tables.js');

const config = { coin: 'BTC' };
const util = {
    isNull: value => value === null || value === undefined
};

function listReader(meta){
    const reader = Object.create(listReaders);
    reader.util = util;
    reader.calls = [];
    reader.getListMetaAction = async () => meta;
    reader.getListCurrentMembership = async (cfg, index, type) => {
        reader.calls.push({ method: 'membership', index, type });
        return {
            edit_resolution_active: true,
            membership_action_index: 44,
            current_list: ['A', 'B'],
            owner: 'owner'
        };
    };
    reader.getListShareMirrorInfo = async (cfg, index) => {
        reader.calls.push({ method: 'mirror', index });
        return null;
    };
    reader.isListEditResolutionActiveAtTip = async () => true;
    return reader;
}

describe('LIST format 5 action detail', function(){
    it('reads the rename row and resolves membership through its list index', async function(){
        const reader = listReader({
            action_index: 90,
            list_action_index: 41,
            name: 'Operators',
            description: 'Current validator set',
            type: 2,
            memo: 'quarterly update',
            status: 'valid'
        });
        const data = { action_format: 5 };

        await reader.attachListActionDetail(config, 90, data);

        assert.deepStrictEqual(data, {
            action_format: 5,
            list: [],
            edits: [],
            type: 2,
            edit: null,
            list_action_index: 41,
            name: 'Operators',
            description: 'Current validator set',
            status: 'valid',
            memo: 'quarterly update',
            state: {
                edit_resolution_active: true,
                membership_action_index: 44,
                current_list: ['A', 'B'],
                owner: 'owner',
                share_mirror: null
            }
        });
        assert.deepStrictEqual(reader.calls, [
            { method: 'membership', index: 41, type: 2 },
            { method: 'mirror', index: 41 }
        ]);
    });

});
describe('LIST format 5 detached reads', function(){
    it('keeps an invalid rename row detached from list root readers', async function(){
        const reader = listReader({
            action_index: 91,
            list_action_index: null,
            name: null,
            description: null,
            type: null,
            memo: null,
            status: 'invalid: LIST_ACTION_INDEX (unknown)'
        });
        const data = { action_format: 5 };

        await reader.attachListActionDetail(config, 91, data);

        assert.strictEqual(data.status, 'invalid: LIST_ACTION_INDEX (unknown)');
        assert.strictEqual(data.list_action_index, null);
        assert.strictEqual(data.name, null);
        assert.strictEqual(data.description, null);
        assert.deepStrictEqual(data.state, {
            edit_resolution_active: true,
            membership_action_index: null,
            current_list: null,
            owner: null,
            share_mirror: null
        });
        assert.deepStrictEqual(reader.calls, []);
    });

    it('does not make the rename index the list membership head', async function(){
        const reader = listReader({
            action_index: 90,
            list_action_index: 41,
            name: 'Renamed',
            description: null,
            type: 1,
            memo: null,
            status: 'valid'
        });
        const data = { action_format: 5 };

        await reader.attachListActionDetail(config, 90, data);

        assert.strictEqual(data.state.membership_action_index, 44);
        assert.deepStrictEqual(data.state.current_list, ['A', 'B']);
        assert.notStrictEqual(data.state.membership_action_index, 90);
        assert.strictEqual(reader.calls[0].index, 41);
    });
});

describe('LIST format 5 block totals', function(){
    it('counts one format 4 lists row and one format 5 metadata row as two actions', async function(){
        const reader = Object.create(blockReaders);
        reader.actionTables = ['lists'];
        reader.doQuery = async (cfg, sql) => {
            sql = String(sql);
            if(sql.includes('count(*) as total')) return [{ total: 1 }];
            if(sql.includes('block_time') && !sql.includes('INNER JOIN actions'))
                return [{ block_index: 12, block_time: 1200 }];
            if(sql.includes('list_metas')) return [{ block_index: 12, count: 1 }];
            return [{ action: 'lists', block_index: 12, count: 1 }];
        };
        const blockConfig = { data: { sql: {
            order: 'DESC',
            limit: 10,
            where: { data: 'b1.block_index IS NOT NULL', offset: '', offsetArgs: [] }
        } } };

        const [blocks] = await reader.getBlocks(blockConfig);

        assert.deepStrictEqual(blocks, [{
            block_index: 12,
            timestamp: 1200,
            actions: { lists: 2 }
        }]);
    });

    it('treats a missing metadata table as zero renames', async function(){
        const reader = Object.create(blockReaders);
        reader.actionTables = ['lists'];
        reader.doQuery = async (cfg, sql) => {
            sql = String(sql);
            if(sql.includes('count(*) as total')) return [{ total: 1 }];
            if(sql.includes('block_time') && !sql.includes('INNER JOIN actions'))
                return [{ block_index: 12, block_time: 1200 }];
            if(sql.includes('list_metas'))
                throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
            return [{ action: 'lists', block_index: 12, count: 1 }];
        };
        const blockConfig = { data: { sql: {
            order: 'DESC', limit: 10,
            where: { data: 'b1.block_index IS NOT NULL', offset: '', offsetArgs: [] }
        } } };

        const [blocks] = await reader.getBlocks(blockConfig);
        assert.deepStrictEqual(blocks[0].actions, { lists: 1 });
    });
});

describe('LIST format 5 network totals', function(){
    it('counts one lists row and one format 5 metadata row as two actions', async function(){
        const reader = Object.create(networkReaders);
        reader.actionTables = ['lists'];
        reader.configInfo = { env: {} };
        reader.pools = { BTC: { config: { database: 'xchain_btc' } } };
        reader._reorgGen = {};
        const calls = [];
        reader.doQuery = async (cfg, sql) => {
            sql = String(sql);
            calls.push(sql);
            if(sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'lists' }];
            if(sql.includes("SELECT 'lists' AS t")) return [{ t: 'lists', c: 1 }];
            if(sql.includes('list_metas'))
                return [
                    { action: 'full_node_verifications', count: 0 },
                    { action: 'lists', count: 1 }
                ];
            if(sql.includes('full_node_verifications'))
                return [{ action: 'full_node_verifications', count: 0 }];
            return [];
        };

        const totals = await reader.getActionTotals(config);

        assert.deepStrictEqual(totals, { lists: 2, full_node_verifications: 0 });
        const renameQuery = calls.find(sql => sql.includes('list_metas'));
        assert.match(renameQuery, /action_format\s*=\s*5/);
        assert.match(renameQuery, /SELECT 'lists' as action[\s\S]*FROM list_metas/);
    });

    it('treats a missing metadata table as zero renames', async function(){
        const reader = Object.create(networkReaders);
        reader.actionTables = ['lists'];
        reader.configInfo = { env: {} };
        reader.pools = { BTC: { config: { database: 'xchain_btc' } } };
        reader._reorgGen = {};
        reader.doQuery = async (cfg, sql) => {
            sql = String(sql);
            if(sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'lists' }];
            if(sql.includes("SELECT 'lists' AS t")) return [{ t: 'lists', c: 1 }];
            if(sql.includes('list_metas'))
                throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
            return [{ action: 'full_node_verifications', count: 0 }];
        };

        const totals = await reader.getActionTotals(config);

        assert.deepStrictEqual(totals, { lists: 1, full_node_verifications: 0 });
    });
});

describe('LIST format 5 query offsets', function(){
    function offsetReader(){
        const reader = Object.create(queryOffsets);
        reader.actionTables = ['lists'];
        reader.cursorPagedMethods = [];
        reader.util = {
            isNull: util.isNull,
            bcadd: (a, b) => Number(a) + Number(b)
        };
        return reader;
    }

    function offsetConfig(){
        return {
            coin: 'BTC',
            data: {
                method: 'getLists',
                type: null,
                query: { length: 10 },
                offset: { action: 'first' }
            }
        };
    }

    it('counts lists rows and format 5 metadata rows when resolving boundaries', async function(){
        const reader = offsetReader();
        const calls = [];
        reader.doQuery = async (cfg, sql) => {
            calls.push(String(sql));
            return calls.length === 1 ? [{ offset_index: 90 }] : [];
        };

        const [offset] = await reader.getQueryOffsets(offsetConfig(), false, 10);

        assert.strictEqual(offset, 91);
        assert.strictEqual(calls.length, 2);
        for(const sql of calls){
            assert.match(sql, /FROM lists l/);
            assert.match(sql, /UNION ALL/);
            assert.match(sql, /FROM list_metas lm/);
            assert.match(sql, /INNER JOIN actions la ON \(la\.action_index=lm\.action_index\)/);
            assert.match(sql, /la\.action_format\s*=\s*5/);
        }
    });
});

describe('LIST format 5 query offset fallback', function(){
    it('retries against lists alone when list_metas is absent', async function(){
        const reader = Object.create(queryOffsets);
        reader.actionTables = ['lists'];
        reader.cursorPagedMethods = [];
        reader.util = {
            isNull: util.isNull,
            bcadd: (a, b) => Number(a) + Number(b)
        };
        const calls = [];
        reader.doQuery = async (cfg, sql) => {
            sql = String(sql);
            calls.push(sql);
            if(sql.includes('list_metas'))
                throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
            return calls.length === 2 ? [{ offset_index: 40 }] : [];
        };
        const renameConfig = {
            coin: 'BTC',
            data: {
                method: 'getLists',
                type: null,
                query: { length: 10 },
                offset: { action: 'first' }
            }
        };

        const [offset] = await reader.getQueryOffsets(renameConfig, false, 10);

        assert.strictEqual(offset, 41);
        assert.strictEqual(calls.length, 3);
        assert.match(calls[0], /list_metas/);
        assert.doesNotMatch(calls[1], /list_metas/);
        assert.doesNotMatch(calls[2], /list_metas/);
    });
});

describe('LIST list-page metadata', function(){
    const sqlConfig = {
        type: 'api',
        data: { sql: {
            order: 'DESC', limit: 100,
            where: { data: 'm.action_index IS NOT NULL', offset: '' }
        } }
    };

    it('keeps list_metas outside the generic action table registry', function(){
        assert.strictEqual(ACTION_TABLES.includes('list_metas'), false);
    });

    it('adds current name and description without listing format 5 rows', async function(){
        const [query, args, count] = await buildListsQuery({}, sqlConfig, async () => true);
        assert.match(query, /FROM lists m/);
        assert.match(query, /lm\.name AS name/);
        assert.match(query, /lm\.description AS description/);
        assert.doesNotMatch(query, /action_format\s*=\s*5/);
        assert.strictEqual(args, null);
        assert.match(count, /FROM lists m/);
        assert.doesNotMatch(count, /list_metas/);
    });

    it('omits metadata columns when list_metas is absent', async function(){
        const [query] = await buildListsQuery({}, sqlConfig, async () => false);
        assert.doesNotMatch(query, /\bAS name\b/);
        assert.doesNotMatch(query, /\bAS description\b/);
        assert.doesNotMatch(query, /FROM list_metas/);
    });
});
