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
 * Unit tests for Database#getCommitments (src/db.js), the M3.8 data leg
 * (spec explorer-coverage-completion, row 25): the block.html "Commitments"
 * section tying state_tree_roots (this coin's own indexer DB) to the covering
 * state_checkpoints row (the co-located hub-mirror schema, via
 * _checkpointSource) and any local ANCHOR action (anchor_actions) that
 * carried it.
 *
 * These exercise the db.js SQL-generating method directly, the same way
 * explorer.checkpoints.test.js's "Database#getCheckpoints (M2.1 data leg)"
 * block covers its sibling hub-mirrored, co-located-DB-only list view: a
 * proxyquired Database with mariadb stubbed out, no live connection.
 *
 * getCommitments/getQueryWhereSql's getCommitments branch/getQueryOffsetSql's
 * getCommitments cursor field/cursorPagedMethods' getCommitments entry are all
 * PROPOSED additions to src/db.js (a shared seam file this builder may not
 * edit directly - see m3-seam-contract.md). These tests are written to run
 * once the main loop splices that proposal in, not to pass vacuously against
 * the current tree.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../src/utility.js');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeRealDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new DatabaseReal(mockExplorer);
}

// Same co-located hub-mirror identity explorer.checkpoints.test.js uses, so a
// row-25 regression surfaces the same way a row-40/41 regression would.
const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function commitmentsConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getCommitments',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

// type='block' bound request, the shape block.html actually drives
// (loadDatatablesData(XC.coin, 'commitment', XC.query, 'block')).
function blockBoundConfig(search, extras = {}) {
    return commitmentsConfig({
        search,
        type: 'block',
        sql: {
            order: 'DESC',
            limit: 100,
            where: { data: 'm.id IS NOT NULL AND m.block_index=?', offset: '', offsetArgs: [] }
        },
        ...extras
    });
}

describe('Database#getCommitments (M3.8 data leg)', () => {

    it('returns a 3-element array', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCommitments(commitmentsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('reads state_tree_roots unqualified (this coin\'s own default schema), aliased m', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('state_tree_roots m');
        expect(count).to.include('state_tree_roots m');
        // Never database-qualified: unlike state_checkpoints, this table lives in
        // the connection's own default schema.
        expect(query).to.not.match(/`[^`]+`\.state_tree_roots/);
    });

    it('LEFT JOINs the co-located hub-mirror state_checkpoints schema, aliased sc, in both queries', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('LEFT JOIN `XChain_Hub`.state_checkpoints sc');
        expect(count).to.include('LEFT JOIN `XChain_Hub`.state_checkpoints sc');
    });

    it('LEFT JOINs the local anchor_actions table, aliased an, in both queries', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('LEFT JOIN anchor_actions an');
        expect(count).to.include('LEFT JOIN anchor_actions an');
        // Never database-qualified: same local pool as state_tree_roots.
        expect(query).to.not.match(/`[^`]+`\.anchor_actions/);
    });

    it('both mirror legs are LEFT JOINs, never INNER: a missing checkpoint or ANCHOR must not drop the row', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig());
        expect(query).to.not.match(/INNER JOIN `[^`]+`\.state_checkpoints/);
        expect(query).to.not.match(/INNER JOIN anchor_actions/);
    });

    it('emits the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig());
        const cols = [
            'm.block_index', 'm.balances_root', 'm.stakes_root', 'm.state_root',
            'm.block_merkle_root', 'm.contract_state_root', 'm.computed_at',
            'sc.checkpoint_seq', 'sc.snapshot_block', 'sc.created_at',
            'JSON_LENGTH(sc.validator_signatures) AS checkpoint_signer_count',
            'an.action_index', 'an.version'
        ];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset, placed after the correlated predicates', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const OFFSET_SQL = ' AND m.block_index < ?';
        const [query] = await db.getCommitments(commitmentsConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        const orderIdx  = query.indexOf('ORDER BY m.block_index');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    it('no unbounded GROUP BY anywhere: latest-per-height is a correlated MAX for BOTH mirror legs', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCommitments(commitmentsConfig());
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
        // Checkpoint leg reuses _latestCheckpointPredicate (frontier rows 40/41's fix).
        expect(query).to.match(/sc\.checkpoint_seq = \(SELECT MAX\(s\.checkpoint_seq\)/);
        // Anchor leg applies the identical shape against anchor_actions.
        expect(query).to.match(/an\.checkpoint_seq = \(SELECT MAX\(a2\.checkpoint_seq\)/);
    });

    it('the checkpoint leg is scoped by chain/network on both the outer join and the correlated subquery', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('sc.chain = ?');
        expect(query).to.include('sc.network = ?');
        expect(query).to.include('s.chain = ?');
        expect(query).to.include('s.network = ?');
    });

    it('the anchor leg is scoped by chain/network: block_index alone is not globally unique across chains', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('an.chain = ?');
        expect(query).to.include('an.network = ?');
        expect(query).to.include('a2.chain = ?');
        expect(query).to.include('a2.network = ?');
    });

    it('count and list share identical FROM+JOIN text so one args array binds correctly against both', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCommitments(commitmentsConfig());
        const joinBlock = (sql) => sql.slice(sql.indexOf('FROM'), sql.indexOf('WHERE'));
        expect(joinBlock(count)).to.equal(joinBlock(query));
    });

    it('args: reuses the (chain,network) filterParams three times (checkpoint outer + checkpoint latest + anchor outer + anchor latest = 4 pairs)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getCommitments(commitmentsConfig());
        // Bare list-all: config.data.search is null, so the method's own return still
        // carries it as the trailing element (getData's shared null-filter trims it on
        // the actual request path, not exercised here - see getCheckpoints' own tests
        // for that shared-seam behavior).
        expect(args).to.deep.equal(['BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', null]);
    });

    it('type=block appends the bound height as the LAST arg, after every join placeholder', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, args] = await db.getCommitments(blockBoundConfig('12345'));
        expect(query).to.include('m.block_index=?');
        expect(args).to.deep.equal(['BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', '12345']);
    });

    it('no checkpoint hub DB configured -> fails loud (no silent empty local mirror)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCommitments(commitmentsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('rejects an unsafe hub DB identifier by failing loud, without leaking it', async () => {
        const db = makeRealDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getCommitments(commitmentsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });

    it('getMaxMethodResults falls back to the platform default of 100 (no per-method override)', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getCommitments')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getCommitments');
    });

    it('getQueryWhereSql anchors getCommitments on m.id IS NOT NULL (no action_index column)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCommitments', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getQueryWhereSql adds m.block_index=? only when type=block, matching getAnchors\' shape', async () => {
        const db = makeRealDb();
        const sqlBare  = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCommitments', type: null } }));
        const sqlBlock = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCommitments', type: 'block' } }));
        expect(sqlBare).to.not.include('block_index');
        expect(sqlBlock).to.equal('m.id IS NOT NULL AND m.block_index=?');
    });

    it('getQueryOffsetSql gives getCommitments the m.block_index cursor field (not m.id)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getCommitments', offset: { action: 'next', start: 500, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.block_index');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([500]);
    });
});
