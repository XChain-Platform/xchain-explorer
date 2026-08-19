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
 * Unit tests for db.js#getMempool's M1.2 rewrite (spec
 * explorer-coverage-completion): the no-type list-all mode and the
 * request-side paging that honors config.data.sql.limit (the bug being
 * fixed is that the old implementation matched ONLY type address/token,
 * returned [] for a bare/list-all request, and ignored sql.limit entirely).
 *
 * Mirrors test/unit/mempool.test.js's mkDb helper: a Database instance with
 * only the decoder-name map + a stubbed doQuery, no real database.
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../src/db.js');

function mkDb(rows) {
    const db = Object.create(Database.prototype);
    const Utility = require('../../src/utility.js');
    db.util = new Utility();
    db.decoderDb = { RBTC: 'XChain_BTC_Decoder' };
    db.doQuery = sinon.stub().resolves(rows);
    return db;
}

// Build N distinct decoder-mempool rows so paging math is easy to assert on
// (row i's data segment is the string 'ROW' + i, unique per row).
function mkRows(n) {
    const rows = [];
    for(let i = 0; i < n; i++)
        rows.push({ tx_hash: 'h' + i, source: 's' + i, data: 'SEND|0|TOK|1|ROW' + i });
    return rows;
}

describe('db.getMempool: list-all mode (M1.2)', () => {

    it('with no type, lists every decoded row rather than returning []', async () => {
        const db = mkDb(mkRows(5));
        const [data, args, total] = await db.getMempool({ coin: 'RBTC', data: { search: null, type: null } });
        expect(args).to.equal(null);
        expect(total).to.equal(5);
        expect(data).to.have.lengthOf(5);
        expect(data.map((r) => r.action)).to.deep.equal(['SEND', 'SEND', 'SEND', 'SEND', 'SEND']);
    });

    it('an empty string type is treated the same as no type (list-all)', async () => {
        const db = mkDb(mkRows(3));
        const [data, , total] = await db.getMempool({ coin: 'RBTC', data: { search: '', type: '' } });
        expect(total).to.equal(3);
        expect(data).to.have.lengthOf(3);
    });

    it('garbage rows are still dropped in list-all mode (decodeMempoolRow returns null)', async () => {
        const db = mkDb([
            { tx_hash: 'a', source: 's', data: 'SEND|0|TOK|1|x' },
            { tx_hash: 'b', source: 's', data: 'not-an-action' },
        ]);
        const [data, , total] = await db.getMempool({ coin: 'RBTC', data: { search: null, type: null } });
        expect(total).to.equal(1);
        expect(data).to.have.lengthOf(1);
    });

    it('address/token filtering still narrows the set in list-all\'s absence (regression guard)', async () => {
        const db = mkDb([
            { tx_hash: 'a', source: 'addrA', data: 'SEND|0|TOK|1|addrB' },
            { tx_hash: 'b', source: 'addrC', data: 'MINT|0|OTHER' },
        ]);
        const [data, , total] = await db.getMempool({ coin: 'RBTC', data: { search: 'addrA', type: 'address' } });
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('a');
    });
});

describe('db.getMempool: paging honors sql.limit (M1.2)', () => {

    it('/api requests slice by sql.apiOffset and cap at sql.limit; total is the pre-slice count', async () => {
        const db = mkDb(mkRows(10));
        const config = {
            coin: 'RBTC',
            type: 'api',
            data: { search: null, type: null, sql: { limit: 3, apiOffset: 3 }, query: {} }
        };
        const [data, , total] = await db.getMempool(config);
        expect(total).to.equal(10);
        expect(data).to.have.lengthOf(3);
        // apiOffset=3, limit=3 -> rows 3,4,5 (0-indexed) -> ROW3..ROW5
        expect(data.map((r) => r.data)).to.deep.equal(['SEND|0|TOK|1|ROW3', 'SEND|0|TOK|1|ROW4', 'SEND|0|TOK|1|ROW5']);
    });

    it('/api requests with no apiOffset start from the first row', async () => {
        const db = mkDb(mkRows(10));
        const config = {
            coin: 'RBTC',
            type: 'api',
            data: { search: null, type: null, sql: { limit: 4 }, query: {} }
        };
        const [data, , total] = await db.getMempool(config);
        expect(total).to.equal(10);
        expect(data).to.have.lengthOf(4);
        expect(data[0].data).to.equal('SEND|0|TOK|1|ROW0');
    });

    it('/explorer requests slice by query.start (DataTables row offset) and cap at sql.limit', async () => {
        const db = mkDb(mkRows(10));
        const config = {
            coin: 'RBTC',
            type: 'explorer',
            data: { search: null, type: null, sql: { limit: 5 }, query: { start: 5, length: 5 } }
        };
        const [data, , total] = await db.getMempool(config);
        expect(total).to.equal(10);
        expect(data).to.have.lengthOf(5);
        expect(data[0].data).to.equal('SEND|0|TOK|1|ROW5');
        expect(data[4].data).to.equal('SEND|0|TOK|1|ROW9');
    });

    it('a page past the end of the matched set returns an empty page, not an error', async () => {
        const db = mkDb(mkRows(3));
        const config = {
            coin: 'RBTC',
            type: 'explorer',
            data: { search: null, type: null, sql: { limit: 5 }, query: { start: 20, length: 5 } }
        };
        const [data, , total] = await db.getMempool(config);
        expect(total).to.equal(3);
        expect(data).to.deep.equal([]);
    });

    it('without a request-shaped sql/limit (minimal internal config), returns the full matched set unsliced', async () => {
        const db = mkDb(mkRows(4));
        const [data, , total] = await db.getMempool({ coin: 'RBTC', data: { search: null, type: null } });
        expect(total).to.equal(4);
        expect(data).to.have.lengthOf(4);
    });
});
