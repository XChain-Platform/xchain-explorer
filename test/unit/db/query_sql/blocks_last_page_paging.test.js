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
 * The blocks list's jump-to-last page, driven through the real query builder,
 * the real paging window and a blocks table holding the columns the list reads: the page holds
 * exactly total - start rows and ends at the lowest block, for a total that is
 * not a multiple of the page length and for a blocks table with missing heights.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const paging = require('../../../../src/explorer/paging.js').methods;
const { assembleResponse } = require('../../../../src/explorer/request/assemble_response.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const LOWEST = 149700;
const GAPS   = new Set([149703, 149704, 149711, 149730]);

let sqlite, db;

// The per-block action count reads hit tables this test does not build; they answer no rows.
const countsQuery = (q) => !String(q).trim() || /list_metas/.test(q);

// Heights LOWEST..LOWEST+count-1, minus the heights in `skip`.
function seedBlocks(count, skip){
    sqlite.exec('DELETE FROM blocks;');
    const ins = sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)');
    let rows = 0;
    for(let h = LOWEST; rows < count; h++){
        if(skip.has(h)) continue;
        ins.run(h, 1700000000 + h);
        rows++;
    }
}

// One /blocks/null last-page request, as the DataTables client sends it.
async function lastPage(start, length, total){
    const query = { start: String(start), length: String(length), action: 'last', total: String(total) };
    const config = makeConfig({
        type: 'explorer',
        data: { method: 'getBlocks', search: 'null', type: 'block', query,
            sql: { order: null, limit: null }, offset: { action: 'last', start: false, stop: null } }
    });
    const [data, rowTotal] = await db.getData(config);
    const st = { cfg: config, data, total: rowTotal, response: {} };
    const util = new Utility(createConfigInfoStub());
    assembleResponse({ util, db, getPagingDataResults: paging.getPagingDataResults }, st);
    return st.response.json.data.map((r) => Number(r[0]));
}

// The heights the table holds, ascending.
function heights(count, skip){
    const out = [];
    for(let h = LOWEST; out.length < count; h++) if(!skip.has(h)) out.push(h);
    return out;
}

function describeTable(label, count, skip){
    describe('blocks last page: ' + label, function () {
        before(function () {
            let DatabaseSync;
            try { ({ DatabaseSync } = require('node:sqlite')); } catch(e){ return this.skip(); }
            sqlite = new DatabaseSync(':memory:');
            sqlite.exec('CREATE TABLE blocks (block_index INTEGER PRIMARY KEY, block_time INTEGER);');
        });
        beforeEach(() => {
            seedBlocks(count, skip);
            const configInfo = createConfigInfoStub();
            db = new Database({ configInfo, util: new Utility(configInfo) });
            db.actionTables = [];
            sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => countsQuery(q) ? [] : runOnSqlite(sqlite, q, a));
        });
        afterEach(() => sinon.restore());

        for(const length of [10, 25]){
            it('holds exactly total - start rows ending at the lowest block, length ' + length, async function () {
                const table = heights(count, skip);
                for(const total of [count, count - 3, count - 7, count - 10]){
                    const start = Math.floor((total - 1) / length) * length;
                    const got = await lastPage(start, length, total);
                    const want = table.slice(0, total - start).reverse();
                    expect(got, 'total ' + total + ' start ' + start).to.deep.equal(want);
                }
            });
        }
    });
}

describeTable('contiguous heights, total not a multiple of the page length', 57, new Set());
describeTable('heights missing from the table', 57, GAPS);
