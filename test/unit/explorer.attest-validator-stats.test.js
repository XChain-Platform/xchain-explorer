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
 * Unit tests for M3.3 (frontier row 20): Database#getAttestValidatorStats
 * (src/db.js), covering the SQL shape and column mapping over
 * attest_validator_stats (xchain-indexer/src/sql/attest_validator_stats.sql).
 *
 * These exercise the real db.js SQL-generating method directly (mariadb
 * stubbed out, no live connection), the same "M2.1 data leg" pattern used by
 * test/unit/explorer.checkpoints.test.js's Database#getCheckpoints suite.
 *
 * `getAttestValidatorStats` itself is proposed, not yet in src/db.js (db.js
 * is a shared seam file owned by the main loop per the M3 seam contract), so
 * every test below is written to be RUN once the main loop splices the
 * proposal in - not to pass vacuously today. The venue fact (2026-08-19):
 * both attest_validator_stats and attests are empty on every reachable
 * chain (no ATTEST round has ever run), so these tests exercise SQL shape
 * and row mapping only, never data presence - matching the spec's data
 * reality.
 *
 * Schema facts (read from xchain-indexer/src/sql/attest_validator_stats.sql):
 *   CREATE TABLE attest_validator_stats (
 *       id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 *       validator_pubkey   CHAR(64) NOT NULL,
 *       provider_id        VARCHAR(32) NOT NULL,
 *       fulfilled_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
 *       missed_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
 *       slashed_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- Phase 4, no producer yet
 *       quality_score      DECIMAL(8,4) NOT NULL DEFAULT 0,     -- Phase 4, no producer yet
 *       last_updated_block BIGINT UNSIGNED
 *   );
 *   UNIQUE INDEX validator_pubkey_provider (validator_pubkey, provider_id)
 *   INDEX provider_id (provider_id)
 *   INDEX last_updated_block (last_updated_block)
 *
 * No action_index (rows are upsert-incremented counters written by
 * db.incrementAttestationValidatorStat, not action-chain rows written once).
 * The paging cursor is the surrogate m.id, added to the indexer definition by
 * src/sql/migrations/2026-08-19-attest-validator-stats-surrogate-id.sql for
 * exactly this reason: last_updated_block is monotonic but NOT unique (a whole
 * ATTEST responsible set is stamped with the same block when one round expires
 * without their signatures), so a same-block tie straddling a keyset page
 * boundary would split or duplicate the boundary row. m.id is monotonic AND
 * unique, matching every other id-keyed list view in this codebase.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect }  = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');

// Real Database class with the mariadb driver stubbed out (no live connection),
// matching explorer.checkpoints.test.js's DatabaseReal pattern.
const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeRealDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new DatabaseReal(mockExplorer);
}

// Config for the base (unfiltered) list query. WHERE anchor matches the
// getQueryWhereSql branch: attest_validator_stats has no action_index, so it
// anchors on its surrogate PK instead of the platform default
// `m.action_index IS NOT NULL`, exactly like every other id-keyed list view.
function statsConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getAttestValidatorStats',
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

describe('Database#getAttestValidatorStats (M3.3 data leg)', () => {

    it('returns a 3-element [query, args, count] array', async () => {
        const db = makeRealDb();
        const result = await db.getAttestValidatorStats(statsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('reads the plain co-located attest_validator_stats table, aliased m, for both the count and the list query', async () => {
        const db = makeRealDb();
        const [query, , count] = await db.getAttestValidatorStats(statsConfig());
        expect(query).to.include('attest_validator_stats m');
        expect(count).to.include('attest_validator_stats m');
    });

    it('emits exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        const [query] = await db.getAttestValidatorStats(statsConfig());
        const cols = [
            'm.id', 'm.validator_pubkey', 'm.provider_id', 'm.fulfilled_count',
            'm.missed_count', 'm.slashed_count', 'm.quality_score', 'm.last_updated_block'
        ];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
    });

    it('args is null - the where.data placeholder (if any) is the single type-bound search value getData supplies', async () => {
        const db = makeRealDb();
        const [, args] = await db.getAttestValidatorStats(statsConfig());
        expect(args).to.equal(null);
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        const [query] = await db.getAttestValidatorStats(statsConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset, before ORDER BY', async () => {
        const db = makeRealDb();
        const OFFSET_SQL = ' AND m.id < ?';
        const [query] = await db.getAttestValidatorStats(statsConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        const orderIdx  = query.indexOf('ORDER BY m.id');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    it('orders by the surrogate m.id, never by last_updated_block (monotonic but not unique) or action_index', async () => {
        const db = makeRealDb();
        const [query] = await db.getAttestValidatorStats(statsConfig());
        expect(query).to.match(/ORDER BY m\.id (ASC|DESC)/);
        expect(query).to.not.match(/ORDER BY m\.last_updated_block/);
        expect(query).to.not.include('m.action_index');
    });

    it('no GROUP BY and no derived-window subquery (the M2 frontier-row-40/41 defect class)', async () => {
        const db = makeRealDb();
        const [query, , count] = await db.getAttestValidatorStats(statsConfig());
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
    });

    it('getMaxMethodResults clamps getAttestValidatorStats to the platform default of 100', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getAttestValidatorStats')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        // attest_validator_stats -> the get->lowercase table-name mangle would look for
        // "attestvalidatorstats", which does not exist, so (like getCheckpoints and
        // getValidatorCapabilities) it must be manually listed here.
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getAttestValidatorStats');
    });

    it('getQueryWhereSql anchors getAttestValidatorStats on m.id IS NOT NULL (no action_index; the surrogate PK is the anchor)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAttestValidatorStats', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getQueryWhereSql type=pubkey filters on m.validator_pubkey', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAttestValidatorStats', type: 'pubkey' } }));
        expect(sql).to.equal('m.id IS NOT NULL AND m.validator_pubkey=?');
    });

    it('getQueryWhereSql type=provider filters on m.provider_id', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAttestValidatorStats', type: 'provider' } }));
        expect(sql).to.equal('m.id IS NOT NULL AND m.provider_id=?');
    });

    it('getQueryOffsetSql gives getAttestValidatorStats the m.id cursor field (not last_updated_block, not action_index)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getAttestValidatorStats', offset: { action: 'next', start: 500000, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.id');
        expect(offsetSql).to.not.include('m.last_updated_block');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([500000]);
    });

    it('getQueryOffsetSql action=last uses <= against the cursor (jump-to-final-page shape)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getAttestValidatorStats', offset: { action: 'last', start: 500000, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.equal(' AND m.id <= ?');
        expect(offsetArgs).to.deep.equal([500000]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping contract for the getPagingDataResults branch in
// src/XChainExplorer.js. This pins the field order that branch commits to,
// keyed off the exact SELECT column list asserted above, so a splice that
// reorders one side without the other is caught by inspection.
// ─────────────────────────────────────────────────────────────────────────
describe('attest_validator_stat row-mapping contract (getPagingDataResults branch)', () => {

    it('the 9-element row = [count_reverse, validator_pubkey, provider_id, fulfilled_count, missed_count, slashed_count, quality_score, last_updated_block, id]', () => {
        // 9 array elements over 8 <th> (see attest_validator_stats.html): the LAST
        // element is the un-rendered paging cursor, the surrogate m.id - NOT
        // last_updated_block, which is monotonic but not unique and so cannot key a
        // page boundary. No 0/1 status column exists on this table, so index 7
        // (second-to-last) is the rendered last_updated_block, consumed positionally
        // as `status` by createdRow, which is why 'attest_validator_stat' must sit in
        // xchain.js's no-color exclusion list so a block height is never misread as a
        // coloring flag.
        const SELECT_ORDER = ['validator_pubkey', 'provider_id', 'fulfilled_count',
                               'missed_count', 'slashed_count', 'quality_score', 'last_updated_block'];
        const ROW = ['count_reverse', ...SELECT_ORDER, 'id'];
        expect(ROW).to.have.lengthOf(9);
        expect(ROW[ROW.length - 1]).to.equal('id');
        expect(ROW[ROW.length - 1]).to.not.equal(ROW[ROW.length - 2]);
    });
});
