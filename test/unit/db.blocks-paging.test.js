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
 * `/{COIN}/blocks` answered 500 DB_ERROR on every coin and every network,
 * for five months, on the public explorer. The page froze in the browser
 * rather than showing an error, because DataTables raised a native alert()
 * on the failed feed - a guard that exists in this tree but was not yet live
 * where the page was being served.
 *
 * CAUSE: getQueryOffsets chose its paging-boundary query on `type`, the
 * FILTER axis, instead of on the table being listed. `blocks` is the one
 * pageable table whose rows are not actions - it carries no action_index
 * at all - and the blocks LIST page passes no type, so it fell through to
 * the generic boundary query, which joins
 * `actions a1 ON (a1.action_index = m.action_index)`:
 *
 *     Unknown column 'm.action_index' in 'SELECT'
 *
 * The same mis-keying ran the other way too: a sends-by-block list DOES
 * pass type=='block', so it took the block-index arithmetic against an
 * offset the boundary query had returned as an action_index. The two sites
 * must agree, because the second interprets the number the first returns,
 * so both now key on the table.
 *
 * Found by an operator opening the page, not by the end-to-end campaign,
 * which reaches pages by seeding actions and following where they lead - and
 * no action seeds a block. The exhaustive route sweep now run alongside that
 * campaign exists because of this defect.
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

// A Database that records every query and answers each with one boundary row, so
// getQueryOffsets runs its full path (boundary query, then the offset2 branch).
function makeDb(){
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.calls = [];
    db.doQuery = async (cfg, sql, args) => {
        db.calls.push({ sql: String(sql), args: args || [] });
        return [{ offset_index: 4200 }];
    };
    return db;
}

const cfg = (method, type, search) => ({
    coin: 'DOGE',
    data: { method, type, search, query: { length: 10 }, offset: { action: 'first', start: 0 } }
});

const boundarySql = db => (db.calls.find(c => /offset_index/.test(c.sql)) || {}).sql || '';

describe('blocks paging: a blocks listing pages over blocks, not over actions', function(){

    it('never joins the actions table when listing blocks', async function(){
        const db = makeDb();
        await db.getQueryOffsets(cfg('getBlocks', undefined, undefined), 0, 10);
        const sql = boundarySql(db);
        assert.ok(sql, 'no boundary query was issued at all');
        assert.ok(!/\bactions\b/.test(sql),
            'the blocks boundary query joins the actions table, which blocks rows are not:\n' + sql);
        assert.ok(!/m\.action_index/.test(sql),
            'the blocks boundary query selects m.action_index, a column blocks does not have:\n' + sql);
    });

    it('pages by block_index, the only cursor a blocks row has', async function(){
        const db = makeDb();
        await db.getQueryOffsets(cfg('getBlocks', undefined, undefined), 0, 10);
        assert.ok(/b1\.block_index as offset_index/.test(boundarySql(db)),
            'the blocks boundary query does not return a block index as its cursor');
    });

    it('takes the same path with no type as it does with type=block', async function(){
        // The list page passes no type; a caller may pass 'block'. Both are listings of
        // blocks and must page identically - keying on type is what broke the first one.
        const a = makeDb(); await a.getQueryOffsets(cfg('getBlocks', undefined, undefined), 0, 10);
        const b = makeDb(); await b.getQueryOffsets(cfg('getBlocks', 'block',    undefined), 0, 10);
        assert.strictEqual(boundarySql(a).replace(/\s+/g, ' '), boundarySql(b).replace(/\s+/g, ' '),
            'a blocks listing pages differently depending on the filter axis it was given');
    });

    it('still pages an ACTION listing by action_index, filter axis notwithstanding', async function(){
        // The guard against over-correcting: a sends list filtered by block is still a
        // list of actions and must keep its action_index cursor.
        const db = makeDb();
        await db.getQueryOffsets(cfg('getSends', 'block', '2900'), 0, 10);
        const sql = boundarySql(db);
        assert.ok(/m\.action_index as offset_index/.test(sql),
            'a sends listing stopped paging by action_index:\n' + sql);
        assert.ok(/\bactions\b/.test(sql), 'a sends listing stopped joining actions');
    });
});
