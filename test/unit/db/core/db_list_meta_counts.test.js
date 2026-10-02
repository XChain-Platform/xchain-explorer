/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb(queryResult){
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.actionTables = ['lists'];
    db.pools = { BTC: { config: { database: 'xchain_btc' }, pool: {} } };
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        const call = { sql: String(sql), args: args || [] };
        db.calls.push(call);
        return queryResult(call, db.calls.length);
    };
    return db;
}

function blocksConfig(){
    return makeConfig({ data: { method: 'getBlocks', sql: {
        order: 'DESC', limit: 10,
        where: { data: 'b1.block_index IS NOT NULL', offset: '', offsetArgs: [] }
    } } });
}

function missingTableError(){
    const error = new Error('missing table');
    error.code = 'ER_NO_SUCH_TABLE';
    return error;
}

describe('LIST rename counts', function(){
    it('adds format 5 list_metas rows to each block lists count', async function(){
        const db = makeDb(call => {
            if(/count\(\*\) as total/.test(call.sql)) return [{ total: 3 }];
            if(/block_time/.test(call.sql)) return [
                { block_index: 12, block_time: 1200 },
                { block_index: 11, block_time: 1100 },
                { block_index: 10, block_time: 1000 }
            ];
            if(/list_metas/.test(call.sql)) return [
                { block_index: 12, count: 1 },
                { block_index: 11, count: 1 }
            ];
            return [
                { block_index: 12, action: 'lists', count: 1 },
                { block_index: 10, action: 'sends', count: 2 }
            ];
        });

        const [blocks] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(blocks, [
            { block_index: 12, timestamp: 1200, actions: { lists: 2 } },
            { block_index: 11, timestamp: 1100, actions: { lists: 1 } },
            { block_index: 10, timestamp: 1000, actions: { sends: 2 } }
        ]);
    });

    it('adds the all-time format 5 count to network totals', async function(){
        const db = makeDb(call => {
            if(/information_schema/.test(call.sql)) return [{ TABLE_NAME: 'lists' }];
            if(/AS t, COUNT\(\*\) AS c/.test(call.sql)) return [{ t: 'lists', c: 1 }];
            return [
                { action: 'full_node_verifications', count: 0 },
                { action: 'lists', count: 1 }
            ];
        });

        const totals = await db.getActionTotals(makeConfig());
        assert.deepStrictEqual(totals, { lists: 2, full_node_verifications: 0 });
    });

    it('treats a missing list_metas table as zero for blocks and totals', async function(){
        const blockDb = makeDb(call => {
            if(/count\(\*\) as total/.test(call.sql)) return [{ total: 1 }];
            if(/block_time/.test(call.sql)) return [{ block_index: 12, block_time: 1200 }];
            if(/list_metas/.test(call.sql)) throw missingTableError();
            return [{ block_index: 12, action: 'lists', count: 1 }];
        });
        const [blocks] = await blockDb.getBlocks(blocksConfig());
        assert.deepStrictEqual(blocks[0].actions, { lists: 1 });

        const totalsDb = makeDb(call => {
            if(/information_schema/.test(call.sql)) return [{ TABLE_NAME: 'lists' }];
            if(/AS t, COUNT\(\*\) AS c/.test(call.sql)) return [{ t: 'lists', c: 1 }];
            if(/list_metas/.test(call.sql)) throw missingTableError();
            return [{ action: 'full_node_verifications', count: 0 }];
        });
        const totals = await totalsDb.getActionTotals(makeConfig());
        assert.deepStrictEqual(totals, { lists: 1, full_node_verifications: 0 });
    });

    it('rethrows non-missing-table failures', async function(){
        const failure = new Error('connection lost');
        const blockDb = makeDb(call => {
            if(/count\(\*\) as total/.test(call.sql)) return [{ total: 1 }];
            if(/block_time/.test(call.sql)) return [{ block_index: 12, block_time: 1200 }];
            if(/list_metas/.test(call.sql)) throw failure;
            return [];
        });
        await assert.rejects(blockDb.getBlocks(blocksConfig()), error => error === failure);

        const totalsDb = makeDb(call => {
            if(/information_schema/.test(call.sql)) return [{ TABLE_NAME: 'lists' }];
            if(/AS t, COUNT\(\*\) AS c/.test(call.sql)) return [{ t: 'lists', c: 1 }];
            throw failure;
        });
        await assert.rejects(totalsDb.getActionTotals(makeConfig()), error => error === failure);
    });

    it('queries list_metas by action_format outside the block action UNION', async function(){
        const db = makeDb(call => {
            if(/count\(\*\) as total/.test(call.sql)) return [{ total: 1 }];
            if(/block_time/.test(call.sql)) return [{ block_index: 12, block_time: 1200 }];
            return [];
        });
        await db.getBlocks(blocksConfig());
        await db.getActionTotals(makeConfig());

        const metaQueries = db.calls.filter(call => /list_metas/.test(call.sql));
        assert.strictEqual(metaQueries.length, 2);
        for(const call of metaQueries)
            assert.match(call.sql, /action_format\s*=\s*5/);
        const blockMeta = metaQueries.find(call => /block_index IN/.test(call.sql));
        assert.ok(blockMeta);
        assert.ok(!/lists' as action/.test(blockMeta.sql));
    });
});
