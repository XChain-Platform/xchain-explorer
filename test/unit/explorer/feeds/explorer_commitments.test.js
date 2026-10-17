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
 * Unit tests for Database#getCommitments (src/db/index.js), the M3.8 data leg
 * (spec explorer-coverage-completion, row 25): the block.html "Commitments"
 * section tying state_tree_roots (this coin's own indexer DB) to the covering
 * state_checkpoints row (the co-located hub-mirror schema, via
 * checkpointSource) and any local ANCHOR action (anchor_actions) that
 * carried it.
 *
 * These exercise the db/index.js SQL-generating method directly, the same way
 * explorer.checkpoints.test.js's "Database#getCheckpoints (M2.1 data leg)"
 * block covers its sibling hub-mirrored, co-located-DB-only list view: a
 * proxyquired Database with mariadb stubbed out, no live connection.
 *
 * getCommitments/getQueryWhereSql's getCommitments branch/getQueryOffsetSql's
 * getCommitments cursor field/cursorPagedMethods' getCommitments entry are all
 * PROPOSED additions to src/db/index.js (a shared seam file this builder may not
 * edit directly - see m3-seam-contract.md). These tests are written to run
 * once the main loop splices that proposal in, not to pass vacuously against
 * the current tree.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../../../src/lib/utility.js');

const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
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
        const [query, , [count]] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('state_tree_roots m');
        expect(count).to.include('state_tree_roots m');
        // Never database-qualified: unlike state_checkpoints, this table lives in
        // the connection's own default schema.
        expect(query).to.not.match(/`[^`]+`\.state_tree_roots/);
    });

    it('LEFT JOINs the co-located hub-mirror state_checkpoints schema, aliased sc, in the list query only', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , [count]] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('LEFT JOIN `XChain_Hub`.state_checkpoints sc');
        expect(count).to.not.include('state_checkpoints');
    });

    it('LEFT JOINs the local anchor_actions table, aliased an, in the list query only', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , [count]] = await db.getCommitments(commitmentsConfig());
        expect(query).to.include('LEFT JOIN anchor_actions an');
        expect(count).to.not.include('anchor_actions');
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
});

describe('Database#getCommitments (M3.8 data leg)', () => {
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

    it('the page derived table carries a LIMIT sourced from config.data.sql.limit, ahead of both legs', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCommitments(commitmentsConfig({ sql: { limit: 37 } }));
        expect(query).to.include('LIMIT 37) m');
        expect(query.indexOf('LIMIT 37')).to.be.lessThan(query.indexOf('LEFT JOIN'));
        expect(query.match(/LIMIT/g)).to.have.lengthOf(2);   // the page and ANCHOR_ONE_ROW_SQL's LIMIT 1
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset, inside the page derived table', async () => {
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
        expect(offsetIdx).to.be.lessThan(query.indexOf('LEFT JOIN'));
    });

    it('no unbounded GROUP BY anywhere: latest-per-height is a correlated MAX for BOTH mirror legs', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , [count]] = await db.getCommitments(commitmentsConfig());
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
        // Checkpoint leg reuses latestCheckpointPredicate (frontier rows 40/41's fix).
        expect(query).to.match(/sc\.checkpoint_seq = \(SELECT MAX\(s\.checkpoint_seq\)/);
        // Anchor leg applies the identical shape against anchor_actions.
        expect(query).to.match(/an\.checkpoint_seq = \(SELECT MAX\(a2\.checkpoint_seq\)/);
    });
});

describe('Database#getCommitments (M3.8 data leg)', () => {
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

    it('the count reads state_tree_roots alone, with no join and no correlated subquery', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, , [count]] = await db.getCommitments(blockBoundConfig('12345'));
        expect(count).to.not.match(/JOIN/i);
        expect(count).to.not.match(/SELECT MAX/i);
        expect(count).to.not.include('(an.action_index');
        expect(count.replace(/\s+/g, ' ').trim())
            .to.equal('SELECT count(*) as total FROM state_tree_roots m WHERE m.id IS NOT NULL AND m.block_index=?');
    });

    it('args: the (chain,network) filterParams four times (checkpoint outer + checkpoint latest + anchor outer + anchor latest)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, args, [count, countArgs]] = await db.getCommitments(commitmentsConfig());
        expect(args).to.deep.equal(['BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet']);
        expect(countArgs).to.deep.equal([]);
        expect(query.match(/\?/g)).to.have.lengthOf(args.length);
        expect(count).to.not.include('?');
    });

    it('type=block binds the height FIRST, inside the page derived table, and alone in the count', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, args, [count, countArgs]] = await db.getCommitments(blockBoundConfig('12345'));
        expect(query.indexOf('m.block_index=?')).to.be.lessThan(query.indexOf('LEFT JOIN'));
        expect(args).to.deep.equal(['12345', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet']);
        expect(countArgs).to.deep.equal(['12345']);
        expect(count.match(/\?/g)).to.have.lengthOf(1);
    });
});

describe('Database#getCommitments (M3.8 data leg)', () => {
    it('no checkpoint hub DB configured -> fails loud (no silent empty local mirror)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCommitments(commitmentsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});

describe('Database#getCommitments (M3.8 data leg)', () => {
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

describe('Database#getCommitments when a v0 section and a v1 archive head share one checkpoint identity', () => {
    async function commitmentQueries() {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        return db.getCommitments(commitmentsConfig());
    }

    it('pins the anchor leg to one row, so the joinless count still counts one row per height', async () => {
        const [query, , [count]] = await commitmentQueries();
        const pin = /\(an\.action_index, an\.section_index\) = \(SELECT a3\.action_index, a3\.section_index[\s\S]*?LIMIT 1\)/;
        expect(query).to.match(pin);
        expect(count).to.not.include('anchor_actions');
    });

    it('ranks checkpoint sections before archive heads, then newest, then section_index', async () => {
        const [query] = await commitmentQueries();
        expect(query).to.include('ORDER BY (a3.version IN (0, 3)) DESC, a3.action_index DESC, a3.section_index DESC');
    });

    it('correlates the pin on the joined row only, so it adds no placeholders', async () => {
        const [query] = await commitmentQueries();
        expect(query).to.include('a3.chain = an.chain AND a3.network = an.network');
        expect(query).to.include('a3.block_index = an.block_index AND a3.checkpoint_seq = an.checkpoint_seq');
        expect(query).to.not.match(/a3\.\w+ = \?/);
    });

    it('filters both the latest-seq lookup and the pin to the checkpoint-bearing versions', async () => {
        const [query] = await commitmentQueries();
        expect(query).to.include('a2.version IN (0, 1, 3)');
        expect(query).to.include('a3.version IN (0, 1, 3)');
    });
});
