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
 * Unit tests for the ANCHOR light-client surface in src/XChainExplorer.js:
 *   GET /{COIN}/api/checkpoints              → processCheckpointsRequest
 *   GET /{COIN}/api/checkpoint/{h}/verify    → processCheckpointVerifyRequest
 *
 * Covers: coin/height validation (404/400), limit clamping, the {checkpoints,
 * count} list shape, and the verify verdict: legacy count quorum, sub-quorum
 * rejection, an unmirrored snapshot, the stake-weighted branch, and the EQUIV
 * uniform-header canonical wrapping. eq/swq activation is pinned per-test so the
 * verdict does not depend on the live flag-day maps.
 */

'use strict';

const { proxyquire, sinon, expect, Utility, createConfigInfoStub, makeConfig } = require('./helpers.js');

// ─────────────────────────────────────────────────────────────────────────
// M2.1 data leg: Database#getCheckpoints / Database#getCheckpoint (src/db/index.js)
//
// These exercise the real db/index.js SQL-generating methods directly, the way
// db.more-queries.test.js's Database#getPriceSnapshots / #getOraclePrices
// suites cover the OTHER hub-mirrored, co-located-DB-only list views: a
// separate proxyquired Database (mariadb stubbed out, no live connection),
// not the MockDB used by the route-level suites above.
// ─────────────────────────────────────────────────────────────────────────

const DatabaseReal = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeRealDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new DatabaseReal(mockExplorer);
}

const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function checkpointsConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getCheckpoints',
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

function checkpointConfig(search) {
    return makeConfig({ data: { method: 'getCheckpoint', search } });
}

describe('Database#getCheckpoints (M2.1 data leg)', () => {
    it('returns a 3-element array', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCheckpoints(checkpointsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('database-qualifies state_checkpoints, aliased m, for both the count and the list query', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCheckpoints(checkpointsConfig());
        expect(query).to.include('`XChain_Hub`.state_checkpoints m');
        expect(count).to.include('`XChain_Hub`.state_checkpoints m');
    });

    it('emits exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig());
        const cols = ['m.block_index', 'm.created_at', 'm.checkpoint_seq', 'm.snapshot_block',
                      'm.state_root', 'm.block_merkle_root', 'JSON_LENGTH(m.validator_signatures) AS signer_count'];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
        // The list carries only the derived signer count, never the raw
        // validator_signatures column, so the detail family's wire-format
        // normalization (see normalizeCheckpointRows) has nothing to act on here.
        const selectClause = query.slice(0, query.indexOf('FROM'));
        expect(selectClause).to.not.include('m.validator_signatures,');
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const OFFSET_SQL = ' AND m.block_index < ?';
        const [query] = await db.getCheckpoints(checkpointsConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        // The inner bounded derived table has its OWN "ORDER BY block_index DESC",
        // so anchor on the outer clause specifically (qualified by the m. alias)
        // rather than the first ORDER BY in the string.
        const orderIdx  = query.indexOf('ORDER BY m.block_index');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });
});

describe('Database#getCheckpoints (M2.1 data leg)', () => {
    it('picks the latest per height WITHOUT a GROUP BY over the mirror', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCheckpoints(checkpointsConfig());
        // The earlier shape pre-selected a fixed window of raw rows and GROUPed it,
        // which capped how deep paging could reach. Latest-per-height is now a
        // correlated MAX on the unique key, so no GROUP BY may appear at all: a
        // reintroduced one is either an unbounded scan or a windowed truncation.
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
        expect(query).to.match(/checkpoint_seq = \(SELECT MAX\(s\.checkpoint_seq\)/);
    });

    it('the paging cursor is not scoped away by the latest-per-height lookup', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig({
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: ' AND m.block_index < ?', offsetArgs: [1000] }
            }
        }));
        // The defect this guards: with the old derived table, the cursor applied only
        // outside a window pinned to the tip, so pages below the window matched nothing.
        // The cursor must sit in the same WHERE as the correlated predicate, and after
        // it, because getData appends the cursor args last.
        const cursorAt = query.indexOf('m.block_index < ?');
        const latestAt = query.indexOf('checkpoint_seq = (SELECT MAX(');
        expect(cursorAt, 'cursor predicate missing').to.be.greaterThan(-1);
        expect(cursorAt, 'cursor must follow the correlated predicate').to.be.greaterThan(latestAt);
    });

    it('count and list both bind chain/network TWICE (outer filter + correlated subquery)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getCheckpoints(checkpointsConfig());
        expect(args).to.deep.equal(['BTC', 'mainnet', 'BTC', 'mainnet']);
    });

    it('no checkpoint hub DB configured -> fails loud (no silent empty local mirror)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCheckpoints(checkpointsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});

describe('Database#getCheckpoints (M2.1 data leg)', () => {
    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeRealDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getCheckpoints(checkpointsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });

    it('getMaxMethodResults clamps getCheckpoints to the platform default of 100', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getCheckpoints')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getCheckpoints');
    });

    it('getQueryWhereSql anchors getCheckpoints on m.id IS NOT NULL (no action_index column)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCheckpoints', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getQueryOffsetSql gives getCheckpoints the m.block_index cursor field (not m.id)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getCheckpoints', offset: { action: 'next', start: 500, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.block_index');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([500]);
    });
});

describe('Database#getCheckpoint (M2.1 single-height detail leg)', () => {
    it('binds the requested height plus the source filterParams positionally', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCheckpoint(checkpointConfig('500'));
        const [, query, args] = doQueryStub.firstCall.args;
        expect(query).to.include('`XChain_Hub`.state_checkpoints');
        expect(query).to.include('ORDER BY checkpoint_seq DESC LIMIT 1');
        expect(args).to.deep.equal([500, 'BTC', 'mainnet']);
    });

    it('selects the full detail column set (state + roots + raw signatures), no verify math', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCheckpoint(checkpointConfig('500'));
        const [, query] = doQueryStub.firstCall.args;
        for (const col of ['chain', 'network', 'block_index', 'block_hash', 'ledger_hash', 'actions_hash',
                            'contract_hash', 'checkpoint_seq', 'snapshot_block', 'state_root',
                            'state_root_version', 'block_merkle_root', 'block_merkle_version',
                            'validator_signatures', 'created_at'])
            expect(query).to.include(col);
    });

    it('returns [null] (array-wrapped) when the height has no checkpoint', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getCheckpoint(checkpointConfig('500'));
        expect(result).to.deep.equal([null]);
    });

    it('normalizes the found row via _normalizeCheckpointRows (BigInt-ish fields stringified, signatures parsed)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const row = {
            chain: 'BTC', network: 'mainnet', block_index: 500n, block_hash: 'h'.repeat(64),
            ledger_hash: 'l'.repeat(64), actions_hash: 'a'.repeat(64), contract_hash: 'c'.repeat(64),
            checkpoint_seq: 7n, snapshot_block: 100n,
            state_root: null, state_root_version: null, block_merkle_root: null, block_merkle_version: null,
            validator_signatures: JSON.stringify([{ pubkey: 'p'.repeat(64), sig: 's'.repeat(128) }]),
            created_at: new Date('2026-08-01T00:00:00Z')
        };
        sinon.stub(db, 'doQuery').resolves([row]);
        const [result] = await db.getCheckpoint(checkpointConfig('500'));
        expect(result.block_index).to.equal('500');
        expect(result.checkpoint_seq).to.equal('7');
        expect(result.snapshot_block).to.equal('100');
        expect(result.validator_signatures).to.deep.equal([{ pubkey: 'p'.repeat(64), sig: 's'.repeat(128) }]);
    });
});

describe('Database#getCheckpoint (M2.1 single-height detail leg)', () => {
    it('no checkpoint hub DB configured -> fails loud', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCheckpoint(checkpointConfig('500')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});
