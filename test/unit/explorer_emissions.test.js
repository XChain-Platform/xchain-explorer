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
 * Unit tests for M3.1 (row 18): the per-CONTRACT emission rollup,
 * Database#getEmissions (src/db.js), proposed in
 * scratchpad/m3-proposal-row18.md (not yet spliced into db.js at the time
 * this file is written; these tests exercise the method's real SQL-generating
 * shape once the splice lands, the same way explorer.checkpoints.test.js's
 * "M2.1 data leg" section covers Database#getCheckpoints/#getCheckpoint).
 *
 * contract_emissions carries no contract_index of its own: it is keyed to an
 * EXECUTION (execution_index = the EXECUTE action's action_index), so the
 * per-contract rollup can only be reached by joining through
 * contract_executions. These tests pin: the join shape, the contract/
 * execution/block type filters landing on the right alias, the LIMIT/ORDER
 * wiring, that the paging cursor is m.id (not the nullable action_index),
 * and the row mapping the section/page-fragment builder proposal depends on.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect }  = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

// Real db.js SQL-generating methods, mariadb stubbed out (no live connection),
// matching the "M2.1 data leg" pattern in explorer.checkpoints.test.js and
// db.more-queries.test.js: these tests read the generated SQL text/args, they
// never execute a query.
const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeRealDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new DatabaseReal(mockExplorer);
}

// Config shaped the way getQuery() would hand it to getEmissions: sql.where.data
// already carries getQueryWhereSql's output for the given type (proposal item 2).
function emissionsConfig(type, search, extras = {}) {
    let whereData = 'm.id IS NOT NULL';
    if (type === 'contract')  whereData += ' AND ce.contract_index=?';
    if (type === 'execution') whereData += ' AND m.execution_index=?';
    if (type === 'block')     whereData += ' AND ce.block_index=?';
    return makeConfig({
        data: {
            method: 'getEmissions',
            search: search === undefined ? null : search,
            type:   type === undefined ? null : type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: whereData, offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

describe('Database#getEmissions (M3.1 data leg)', () => {

    it('returns a 3-element [query, args, count] array', async () => {
        const db = makeRealDb();
        const result = await db.getEmissions(emissionsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('args is null: the method adds no placeholder of its own beyond the type-bound one', async () => {
        const db = makeRealDb();
        const [, args] = await db.getEmissions(emissionsConfig());
        expect(args).to.equal(null);
    });

    it('joins contract_emissions (aliased m) to contract_executions (aliased ce) on execution_index = ce.action_index', async () => {
        const db = makeRealDb();
        const [query, , count] = await db.getEmissions(emissionsConfig());
        expect(query).to.include('contract_emissions m');
        expect(query).to.include('INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)');
        expect(count).to.include('contract_emissions m');
        expect(count).to.include('INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)');
    });

    it('reaches block_index/timestamp through contract_executions.block_index directly (no actions/transactions hop)', async () => {
        const db = makeRealDb();
        const [query] = await db.getEmissions(emissionsConfig());
        expect(query).to.include('INNER JOIN blocks               b1 ON (b1.block_index=ce.block_index)');
        expect(query).to.not.include('actions');
        expect(query).to.not.include('transactions');
    });

    it('selects exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        const [query] = await db.getEmissions(emissionsConfig());
        const selectClause = query.slice(0, query.indexOf('FROM'));
        const cols = ['m.id', 'm.execution_index', 'ce.contract_index', 'm.position',
                      'm.emitted_action', 'm.action_index', 'b1.block_index',
                      'b1.block_time as timestamp', 's1.status'];
        let cursor = -1;
        for (const col of cols) {
            const idx = selectClause.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
    });

    it('the count query has no LIMIT/ORDER and no offset fragment', async () => {
        const db = makeRealDb();
        const [, , count] = await db.getEmissions(emissionsConfig());
        expect(count).to.not.match(/LIMIT/i);
        expect(count).to.not.match(/ORDER BY/i);
        expect(count.trim().startsWith('SELECT')).to.equal(true);
        expect(count).to.include('count(*) as total');
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit, interpolated (not bound)', async () => {
        const db = makeRealDb();
        const [query] = await db.getEmissions(emissionsConfig('contract', '73', { sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('orders by m.id (the paging cursor), never by the nullable action_index', async () => {
        const db = makeRealDb();
        const [query] = await db.getEmissions(emissionsConfig());
        expect(query).to.match(/ORDER BY m\.id (ASC|DESC)/);
        expect(query).to.not.match(/ORDER BY m\.action_index/);
    });

    it('never GROUPs BY and never derives a windowed "latest N" subselect (spec ss8 hard rule)', async () => {
        const db = makeRealDb();
        const [query, , count] = await db.getEmissions(emissionsConfig('contract', '73'));
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset, placed before ORDER BY', async () => {
        const db = makeRealDb();
        const OFFSET_SQL = ' AND m.id < ?';
        const [query] = await db.getEmissions(emissionsConfig('contract', '73', {
            sql: { where: { data: 'm.id IS NOT NULL AND ce.contract_index=?', offset: OFFSET_SQL, offsetArgs: [500] } }
        }));
        const offsetIdx = query.indexOf(OFFSET_SQL);
        const orderIdx  = query.indexOf('ORDER BY m.id');
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    // ── getQueryWhereSql: type -> WHERE branch (proposal item 2) ──────────

    describe('getQueryWhereSql routing for getEmissions', () => {
        it('anchors on m.id IS NOT NULL (contract_emissions has no reliable action_index)', async () => {
            const db = makeRealDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getEmissions', type: null } }));
            expect(sql).to.equal('m.id IS NOT NULL');
        });

        it('type=contract filters on the joined ce.contract_index, not m.contract_index', async () => {
            const db = makeRealDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getEmissions', type: 'contract' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND ce.contract_index=?');
        });

        it('type=execution filters on contract_emissions\' own indexed execution_index column', async () => {
            const db = makeRealDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getEmissions', type: 'execution' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND m.execution_index=?');
        });

        it('type=block filters on the joined ce.block_index, not the generic b1 branch', async () => {
            const db = makeRealDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getEmissions', type: 'block' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND ce.block_index=?');
        });

        it('an unrecognized type adds no extra predicate (falls through untouched)', async () => {
            const db = makeRealDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getEmissions', type: 'address' } }));
            expect(sql).to.equal('m.id IS NOT NULL');
        });
    });

    // ── Cursor registration (proposal item 3) ──────────────────────────────

    describe('cursor registration', () => {
        it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
            const db = makeRealDb();
            expect(db.cursorPagedMethods).to.include('getEmissions');
        });

        it('getQueryOffsetSql gives getEmissions the m.id cursor field (not m.action_index)', async () => {
            const db = makeRealDb();
            const config = makeConfig({
                data: { method: 'getEmissions', offset: { action: 'next', start: 500, stop: false } }
            });
            const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
            expect(offsetSql).to.include('m.id');
            expect(offsetSql).to.not.include('m.action_index');
            expect(offsetArgs).to.deep.equal([500]);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping shape the getPagingDataResults branch (proposal item 5) and the
// xchain.js render branch (proposal item 6) depend on: array length/order and
// which element is the paging cursor / which is the borrowed execution status.
// This is a plain data-shape test (no live XChainExplorer instance needed):
// it locks the CONTRACT the two proposed branches must honor, independent of
// whether the splice has landed yet.
// ─────────────────────────────────────────────────────────────────────────
describe('getEmissions row-mapping contract (for the proposed getPagingDataResults branch)', () => {
    // Mirrors one measured venue row (contract_index 73 carries 4 emissions
    // across more than one execution): a resolved, on-wire child action.
    const ROW_WITH_CHILD = {
        id: 101, execution_index: 55, contract_index: 73, position: 0,
        emitted_action: 'emit.execute', action_index: 202,
        block_index: 900, timestamp: 1750000000, status: 'valid'
    };
    // An internal emission (e.g. SLASH): action_index is null by schema design.
    const ROW_INTERNAL = {
        id: 102, execution_index: 55, contract_index: 73, position: 1,
        emitted_action: 'SLASH', action_index: null,
        block_index: 900, timestamp: 1750000000, status: 'valid'
    };

    function mapRow(info, count_reverse) {
        // Same shape as the proposed getPagingDataResults branch (proposal item 5).
        return [count_reverse, info.block_index, info.timestamp, info.execution_index,
                info.contract_index, info.position, info.emitted_action, info.action_index,
                info.status, info.id];
    }

    it('produces a 10-element array (9 visible <th>, matching the id-keyed uncoloured shape)', () => {
        const row = mapRow(ROW_WITH_CHILD, 1);
        expect(row).to.have.lengthOf(10);
    });

    it('the LAST element is always the paging cursor (m.id), never the nullable action_index', () => {
        const row = mapRow(ROW_WITH_CHILD, 1);
        expect(row[row.length - 1]).to.equal(ROW_WITH_CHILD.id);
        const rowInternal = mapRow(ROW_INTERNAL, 2);
        expect(rowInternal[rowInternal.length - 1]).to.equal(ROW_INTERNAL.id);
        // action_index (nullable) sits second-from-cursor, never last: the internal
        // emission's null action_index must not silently become the paging cursor.
        expect(rowInternal[rowInternal.length - 1]).to.not.equal(null);
    });

    it('the SECOND-TO-LAST element is the borrowed EXECUTE status, consumed by createdRow', () => {
        const row = mapRow(ROW_WITH_CHILD, 1);
        expect(row[row.length - 2]).to.equal('valid');
    });

    it('carries a null child action_index through untouched for an internal emission (e.g. SLASH)', () => {
        const row = mapRow(ROW_INTERNAL, 2);
        // index 7 = action_index per the fixed column order (see mapRow / proposal item 5)
        expect(row[7]).to.equal(null);
        expect(row[6]).to.equal('SLASH');
    });

    it('keeps execution_index and contract_index in their fixed positions (3 and 4)', () => {
        const row = mapRow(ROW_WITH_CHILD, 1);
        expect(row[3]).to.equal(55);   // execution_index
        expect(row[4]).to.equal(73);   // contract_index
    });
});
