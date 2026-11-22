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
 **********************************************************************
 *
 * The blocks list counts each part of a multi-part FILE as a FILE action. Parts
 * live in file_parts rather than files, so getBlocks reads them in one bulk query
 * per page and adds them to the files count; an indexer without the multipart
 * migration keeps the counts it read.
 *
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

// A Database over a page of `page` blocks where block 12 holds one files row, and
// `parts` answers the file_parts count (an Error is thrown instead).
function makeDb(page, parts){
    const db = new Database({ configInfo: createConfigInfoStub(), util: new Utility(createConfigInfoStub()) });
    db.actionTables = ['files', 'sends'];
    db.pools = { BTC: { config: { database: 'xchain_btc' }, pool: {} } };
    db.calls = [];
    db.doQuery = async (config, sql) => {
        db.calls.push(String(sql));
        if(/MAX\(block_index\) AS tip/.test(sql)) return [{ tip: null }];
        if(/count\(\*\) as total/.test(sql)) return [{ total: page.length }];
        if(/block_time/.test(sql)) return page.map(b => ({ block_index: b, block_time: b * 100 }));
        if(/list_metas/.test(sql)) return [];
        if(/FROM\s+file_parts/.test(sql)){
            if(parts instanceof Error) throw parts;
            return parts;
        }
        return [{ block_index: 12, action: 'files', count: 1 }, { block_index: 11, action: 'sends', count: 2 }];
    };
    return db;
}

function blocksConfig(){
    return makeConfig({ coin: 'BTC', data: { method: 'getBlocks', sql: {
        order: 'DESC', limit: 30,
        where: { data: 'b1.block_index IS NOT NULL', offset: '', offsetArgs: [] }
    } } });
}

describe('blocks list file part counts merge', function(){
    it('adds parts to a block that counts files and gives a part-only block a files count', async function(){
        const db = makeDb([12, 11, 10], [{ block_index: 12, count: 2 }, { block_index: 10, count: '3' }]);
        const [blocks] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(blocks.map(b => b.actions), [{ files: 3 }, { sends: 2 }, { files: 3 }]);
    });
});

describe('blocks list file part counts without the multipart migration', function(){
    it('keeps the counts it read when file_parts is absent', async function(){
        const missing = Object.assign(new Error('missing table'), { code: 'ER_NO_SUCH_TABLE' });
        const db = makeDb([12, 11, 10], missing);
        const [blocks] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(blocks.map(b => b.actions), [{ files: 1 }, { sends: 2 }, {}]);
    });

    it('rethrows any other file_parts failure', async function(){
        const failure = new Error('connection lost');
        const db = makeDb([12], failure);
        await assert.rejects(db.getBlocks(blocksConfig()), e => e === failure);
    });
});

describe('blocks list file part counts query count', function(){
    it('runs the same statements, one file_parts read, at 2 and 26 blocks', async function(){
        const counts = [];
        for(const size of [2, 26]){
            const db = makeDb(Array.from({ length: size }, (_, i) => 100 - i), []);
            await db.getBlocks(blocksConfig());
            assert.strictEqual(db.calls.filter(sql => /FROM\s+file_parts/.test(sql)).length, 1);
            counts.push(db.calls.length);
        }
        assert.strictEqual(counts[0], counts[1]);
    });
});
