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
 *
 * The indexed address and block lanes against every routed list reader.
 *
 * The lanes rewrite a2.address=? and b1.block_index=? into predicates on the
 * actions columns those joins resolve to, which is only the same row set when
 * the reader's joins say so. These cases read the joins out of the installed
 * readers' own SQL: every method in a lane carries the join that makes the
 * rewrite exact, every reader with that join is in the lane, and every query
 * a lane builds binds exactly as many values as it has placeholders.
 *
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { listQueryArgs }        = require('../../../../src/db/query_sql/data_rows.js');
const { boundaryWhere }        = require('../../../../src/db/query_sql/offset_boundaries.js');
const lanes = require('../../../../src/db/query_sql/where_source_lanes.js');
const { DEFAULT_ANCHOR, whereAnchor } = require('../../../../src/db/query_sql/where_anchors.js');
const apiRoutes      = require('../../../../src/explorer/routes/api_methods.js');
const explorerRoutes = require('../../../../src/explorer/routes/explorer_feeds.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ADDRESS_ID      = 7;
const SOURCE_JOIN     = 'COALESCE(a1.source_id, t1.source_id)';
const ACTION_BLOCK_ON = 'b1 ON (b1.block_index=a1.block_index)';

function makeDb() {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = async (config, sql) =>
        (String(sql).includes('FROM index_addresses WHERE address=?') ? [{ id: ADDRESS_ID }] : []);
    return db;
}

// Every [method, type] pair the two route tables accept.
function routedPairs() {
    const pairs = new Map();
    const walk = (node) => {
        for (const value of Object.values(node)) {
            if (Array.isArray(value) && typeof value[0] === 'string') {
                const types = Array.isArray(value[1]) ? value[1] : (value[1] ? [value[1]] : []);
                for (const type of types) pairs.set(value[0] + '|' + type, [value[0], type]);
            } else if (value && typeof value === 'object') {
                walk(value);
            }
        }
    };
    walk(apiRoutes);
    walk(explorerRoutes);
    return [...pairs.values()];
}

// Readers that serve only from a co-located hub DB refuse to build here. None
// is in either lane, and a lane method that failed to build would fail loudly.
const HUB_ONLY_READERS = new Set(['getCheckpoint']);

// Builds one request the way getQuery does: the data-WHERE first, then the reader.
async function build(db, method, type) {
    const config = makeConfig({ data: { method, type, search: 'ADDR' } });
    const where  = await db.getQueryWhereSql(config);
    config.data.sql.where.data = where;
    const [query, args, count] = await db[method](config);
    return { config, where, query, args, count };
}

function placeholders(sql) {
    return (String(sql).match(/\?/g) || []).length;
}

function readerSql(built) {
    return [built.query, built.count].filter((sql) => typeof sql === 'string');
}

// The action-list readers: the ones anchored on m.action_index. The id-keyed
// hub mirrors carry no actions join and refuse to build without a hub DB.
const LANE_TYPES = new Set(['address', 'source', 'block']);
const PAIRS = routedPairs().filter(([method, type]) =>
    LANE_TYPES.has(type) && typeof Database.prototype[method] === 'function'
    && whereAnchor(method) === DEFAULT_ANCHOR && !HUB_ONLY_READERS.has(method));

describe('indexed lanes: scope', function () {
    it('leaves out only hub-only readers, none of which is in a lane', function () {
        for (const method of HUB_ONLY_READERS) {
            expect(lanes.ACTION_SOURCE_METHODS.has(method)).to.equal(false);
            expect(lanes.ACTION_BLOCK_METHODS.has(method)).to.equal(false);
        }
    });
});

describe('indexed source lane: which readers take it', function () {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('every method in the lane reaches the address through the action and its transaction', async function () {
        for (const [method, type] of PAIRS) {
            const built = await build(db, method, type);
            if (!built.where.includes(lanes.ACTION_SOURCE_SQL)) continue;
            for (const sql of readerSql(built)) {
                expect(sql, method).to.match(/\bactions\s+a1\b/);
                expect(sql, method).to.match(/\btransactions\s+t1\b/);
                if (method !== 'getCoinpayExpires')
                    expect(sql, method).to.include(SOURCE_JOIN);
            }
        }
    });

    it('every reader whose source join is the action source takes the indexed lane', async function () {
        for (const [method, type] of PAIRS) {
            if (type === 'block') continue;
            const built = await build(db, method, type);
            if (!/ AND a2\.address=\?$/.test(built.where)) continue;
            for (const sql of readerSql(built))
                expect(sql, `${method} ${type}: a2 joins the action source, so a2.address=? scans`)
                    .to.not.match(/a2 ON \(a2\.id=COALESCE\(a1\.source_id, t1\.source_id\)\)/);
        }
    });

    it('fixes the coinpays and coinpay expires address lanes, which have no a2 address join', async function () {
        for (const method of ['getCoinpays', 'getCoinpayExpires']) {
            const built = await build(db, method, 'address');
            expect(built.where).to.include(lanes.ACTION_SOURCE_SQL);
            for (const sql of readerSql(built))
                expect(sql).to.not.match(/a2\.address/);
        }
    });
});

describe('indexed block lane: which readers take it', function () {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('every method in the lane joins blocks on the action block in both queries', async function () {
        for (const [method, type] of PAIRS) {
            if (type !== 'block') continue;
            const built = await build(db, method, type);
            if (!built.where.endsWith(' AND a1.block_index=?')) continue;
            for (const sql of readerSql(built))
                expect(sql, method).to.include(ACTION_BLOCK_ON);
        }
    });

    it('every reader that joins blocks on the action block takes the indexed lane', async function () {
        for (const [method, type] of PAIRS) {
            if (type !== 'block') continue;
            const built = await build(db, method, type);
            if (!built.where.endsWith(' AND b1.block_index=?')) continue;
            const shapes = readerSql(built);
            const allOnAction = shapes.length > 0 && shapes.every((sql) => sql.includes(ACTION_BLOCK_ON));
            expect(allOnAction, `${method}: b1 is the action block, so b1.block_index=? scans`).to.equal(false);
        }
    });

    it('names only methods the route tables accept a block filter for', function () {
        const routed = new Set(PAIRS.filter(([, type]) => type === 'block').map(([method]) => method));
        const unrouted = [...lanes.ACTION_BLOCK_METHODS].filter((method) =>
            !routed.has(method) && method !== 'getCollectibles');
        expect(unrouted).to.deep.equal([]);
    });
});

describe('indexed lanes bind exactly their placeholders', function () {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('binds the resolved id twice for the source lane, in the row and the count query', async function () {
        let checked = 0;
        for (const [method, type] of PAIRS) {
            const built = await build(db, method, type);
            if (!built.where.includes(lanes.ACTION_SOURCE_SQL)) continue;
            const bound = listQueryArgs(db, built.config, built.args);
            expect(bound, method).to.deep.equal([ADDRESS_ID, ADDRESS_ID]);
            for (const sql of readerSql(built))
                expect(placeholders(sql), `${method} ${type}`).to.equal(bound.length);
            checked++;
        }
        expect(checked).to.be.greaterThan(30);
    });

    it('binds the block once for the block lane, in the row and the count query', async function () {
        let checked = 0;
        for (const [method, type] of PAIRS) {
            if (type !== 'block') continue;
            const built = await build(db, method, type);
            if (!built.where.endsWith(' AND a1.block_index=?')) continue;
            const bound = listQueryArgs(db, built.config, built.args);
            for (const sql of readerSql(built))
                expect(placeholders(sql), method).to.equal(bound.length);
            checked++;
        }
        expect(checked).to.be.greaterThan(25);
    });
});

describe('explorer paging boundaries take the same indexed predicates', function () {
    let db;
    beforeEach(() => { db = makeDb(); });

    it('filters a single-party address boundary on the action source, binding the id twice', async function () {
        const config = makeConfig({ data: { method: 'getIssues', type: 'address', search: 'ADDR' } });
        const { where, whereArgs } = await boundaryWhere(db, config);
        expect(where).to.equal(lanes.ACTION_SOURCE_SQL);
        expect(whereArgs).to.deep.equal([ADDRESS_ID, ADDRESS_ID]);
    });

    it('filters a block boundary on the action block, and the blocks listing on b1', async function () {
        const issues = await boundaryWhere(db, makeConfig({ data: { method: 'getIssues', type: 'block', search: '5' } }));
        expect(issues.where).to.equal(' AND a1.block_index=?');
        const blocks = await boundaryWhere(db, makeConfig({ data: { method: 'getBlocks', type: 'block', search: '5' } }));
        expect(blocks.where).to.equal(' AND b1.block_index=?');
    });
});
