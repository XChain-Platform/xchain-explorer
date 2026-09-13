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
 * Unit tests for M3.2 (row 19): vote_delegations (VOTE v3 liquid democracy).
 *
 * vote_delegations is an APPEND-ONLY event log: a holder can set, re-point, or
 * clear (revoke) their standing per-token delegation, and each of those writes a
 * NEW row rather than mutating the old one. The entire point of this row is that
 * the live delegation for a (tick_id, delegator) is its LATEST row, and only when
 * that latest row is not a CLEAR (delegate_address_id IS NOT NULL) - a naive
 * `SELECT *` would show every revoked/re-pointed delegation as if it were live.
 *
 * These tests exercise the SQL shape (Database#getVoteDelegations, proposed for
 * src/db.js) and the type filter (Database#getQueryWhereSql's proposed branch)
 * directly, the way test/unit/explorer.checkpoints.test.js's "M2.1 data leg"
 * suite covers Database#getCheckpoints: they cannot run until the main loop
 * splices this row's db.js proposal in, which is expected (per the seam
 * contract, write to be run, not to pass vacuously).
 */

'use strict';

const { expect }    = require('chai');
const proxyquire    = require('proxyquire');
const Utility       = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

// Database instance with no real MariaDB connection, matching
// explorer.checkpoints.test.js / db.query-builder.test.js's own proxyquired setup.
const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeDb(){
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new Database(mockExplorer);
}

// getVoteDelegations' own config: no {TYPE}, listing every live delegation.
function voteDelegationsConfig(extras = {}){
    return makeConfig({
        data: {
            method: 'getVoteDelegations',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

// getQueryWhereSql / getQueryOffsetSql helper, matching db.query-builder.test.js's cfg().
function cfg(method, type, extras = {}){
    return makeConfig({ data: { method, type, ...extras } });
}

describe('Database#getVoteDelegations (M3.2 data leg)', () => {

    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getVoteDelegations(voteDelegationsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('args is null: the single type-bound placeholder comes from getQueryWhereSql, not a returned array', async () => {
        const db = makeDb();
        const [, args] = await db.getVoteDelegations(voteDelegationsConfig());
        expect(args).to.equal(null);
    });

    it('both the count and list query read FROM vote_delegations aliased m', async () => {
        const db = makeDb();
        const [query, , count] = await db.getVoteDelegations(voteDelegationsConfig());
        expect(query).to.include('vote_delegations m');
        expect(count).to.include('vote_delegations m');
    });

    it('resolves tick_id/delegator_address_id/delegate_address_id through the index_* lookup tables, not as raw ids', async () => {
        const db = makeDb();
        const [query] = await db.getVoteDelegations(voteDelegationsConfig());
        expect(query).to.match(/LEFT\s+JOIN\s+index_tickers\s+t3\s+ON\s*\(t3\.id=m\.tick_id\)/);
        expect(query).to.match(/LEFT\s+JOIN\s+index_addresses\s+dgr\s+ON\s*\(dgr\.id=m\.delegator_address_id\)/);
        expect(query).to.match(/LEFT\s+JOIN\s+index_addresses\s+dg\s+ON\s*\(dg\.id=m\.delegate_address_id\)/);
        // The displayed columns are the resolved tick/address text, not the bare id.
        expect(query).to.include('t3.tick');
        expect(query).to.include('dgr.address as delegator');
        expect(query).to.include('dg.address as delegate');
    });

    it('joins the actions/transactions/blocks chain like getContractDelegations (action-backed row)', async () => {
        const db = makeDb();
        const [query] = await db.getVoteDelegations(voteDelegationsConfig());
        expect(query).to.match(/INNER\s+JOIN\s+actions\s+a1\s+ON\s*\(a1\.action_index=m\.action_index\)/);
        expect(query).to.match(/INNER\s+JOIN\s+transactions\s+t1\s+ON\s*\(t1\.tx_index=a1\.tx_index\)/);
        expect(query).to.match(/INNER\s+JOIN\s+blocks\s+b1\s+ON\s*\(b1\.block_index=t1\.block_index\)/);
    });

    // The row's entire substance: the latest-active-per-key exclusion.
    describe('latest-active-per-(tick_id, delegator) semantics', () => {

        it('excludes superseded rows via a correlated MAX on (tick_id, delegator_address_id), never a GROUP BY', async () => {
            const db = makeDb();
            const [query, , count] = await db.getVoteDelegations(voteDelegationsConfig());
            // Frontier rows 40/41's defect class: a derived "newest N rows" table the
            // cursor applies OUTSIDE of. There must be no GROUP BY anywhere in this query.
            expect(query).to.not.match(/GROUP BY/i);
            expect(count).to.not.match(/GROUP BY/i);
            const correlated = /m\.action_index\s*=\s*\(\s*SELECT\s+MAX\(s\.action_index\)\s+FROM\s+vote_delegations\s+s\s+WHERE\s+s\.tick_id=m\.tick_id\s+AND\s+s\.delegator_address_id=m\.delegator_address_id\s*\)/;
            expect(query).to.match(correlated);
            expect(count).to.match(correlated);
        });

        it('excludes the latest-is-a-CLEAR case via delegate_address_id IS NOT NULL', async () => {
            const db = makeDb();
            const [query, , count] = await db.getVoteDelegations(voteDelegationsConfig());
            expect(query).to.include('m.delegate_address_id IS NOT NULL');
            expect(count).to.include('m.delegate_address_id IS NOT NULL');
        });

        it('the correlated predicate and the cursor sit in the SAME outer WHERE as sql.where.data (never a scoped-away derived table)', async () => {
            const db = makeDb();
            const OFFSET_SQL = ' AND m.action_index < ?';
            const [query] = await db.getVoteDelegations(voteDelegationsConfig({
                sql: { where: { data: 'm.action_index IS NOT NULL', offset: OFFSET_SQL, offsetArgs: [12345] } }
            }));
            const latestAt = query.indexOf('SELECT MAX(s.action_index)');
            const offsetAt = query.indexOf(OFFSET_SQL);
            const orderAt  = query.indexOf('ORDER BY m.action_index');
            expect(latestAt, 'correlated predicate missing').to.be.greaterThan(-1);
            expect(offsetAt, 'offset cursor missing').to.be.greaterThan(-1);
            // The defect this guards against: with a pre-windowed derived table, a deep
            // page's cursor compares against rows the window never included, so it must
            // follow the correlated predicate in the same WHERE, not sit outside a join.
            expect(offsetAt).to.be.greaterThan(latestAt);
            expect(orderAt).to.be.greaterThan(offsetAt);
        });

        it('the count query carries the same latest-active predicate as the list query (consistent totals)', async () => {
            const db = makeDb();
            const [query, , count] = await db.getVoteDelegations(voteDelegationsConfig());
            const extract = (sql) => (sql.match(/m\.action_index\s*=\s*\(\s*SELECT MAX\(s\.action_index\)[\s\S]*?\)/) || [null])[0];
            const listPred  = extract(query);
            const countPred = extract(count);
            expect(listPred).to.not.equal(null);
            expect(countPred).to.not.equal(null);
            expect(listPred.replace(/\s+/g, ' ')).to.equal(countPred.replace(/\s+/g, ' '));
        });
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeDb();
        const [query] = await db.getVoteDelegations(voteDelegationsConfig({ sql: { limit: 42 } }));
        expect(query.trim().endsWith('LIMIT 42')).to.equal(true);
    });

    it('orders by m.action_index using config.data.sql.order', async () => {
        const db = makeDb();
        const [query] = await db.getVoteDelegations(voteDelegationsConfig({ sql: { order: 'ASC' } }));
        expect(query).to.match(/ORDER BY m\.action_index\s+ASC/);
    });

    it('is registered in cursorPagedMethods (the get->lowercase table mangle collides on the underscore, like getContractDelegations)', () => {
        const db = makeDb();
        expect(db.cursorPagedMethods).to.include('getVoteDelegations');
    });

    it('getMaxMethodResults falls through to the platform default of 100 (no per-method override)', () => {
        const db = makeDb();
        expect(db.getMaxMethodResults('getVoteDelegations')).to.equal(100);
    });
});

describe('Database#getQueryWhereSql for getVoteDelegations (type in {tick, delegator, delegate, block})', () => {

    it('with no type: base anchor is m.action_index IS NOT NULL (action_index is NOT NULL on this table)', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('type=tick filters the resolved tick text (t3.tick), not the raw tick_id', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', 'tick'));
        expect(sql).to.include('t3.tick=?');
        expect(sql).to.not.include('m.tick_id=?');
    });

    it('type=delegator filters the resolved delegator address (dgr.address)', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', 'delegator'));
        expect(sql).to.include('dgr.address=?');
    });

    it('type=delegate filters the resolved delegate address (dg.address), distinct from delegator', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', 'delegate'));
        expect(sql).to.include('dg.address=?');
        expect(sql).to.not.include('dgr.address=?');
    });

    it('type=block filters the action chain block (b1.block_index), not a bare m.block_index', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', 'block'));
        expect(sql).to.include('b1.block_index=?');
    });

    it('an unrecognized type adds no extra clause (falls through cleanly)', async () => {
        const db = makeDb();
        const sql = await db.getQueryWhereSql(cfg('getVoteDelegations', 'bogus'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });
});
