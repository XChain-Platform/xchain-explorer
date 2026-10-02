/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *********************************************************************/

'use strict';

const assert = require('assert');
const listReaders = require('../../../src/db/readers/action_detail_io/lists.js');
const blockReaders = require('../../../src/db/readers/entities/blocks.js');
const { ACTION_TABLES, buildListsQuery } = require('../../../src/db/method_tables.js');

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
        const [query] = await buildListsQuery({}, sqlConfig, async () => true);
        assert.match(query, /FROM lists m/);
        assert.match(query, /lm\.name AS name/);
        assert.match(query, /lm\.description AS description/);
        assert.doesNotMatch(query, /action_format\s*=\s*5/);
    });

    it('returns null metadata columns when list_metas is absent', async function(){
        const [query] = await buildListsQuery({}, sqlConfig, async () => false);
        assert.match(query, /NULL AS name/);
        assert.match(query, /NULL AS description/);
        assert.doesNotMatch(query, /FROM list_metas/);
    });
});
