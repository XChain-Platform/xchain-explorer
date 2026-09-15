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
 * Unit tests for SQL generation functions in src/db/index.js
 *
 * Tests:
 *   - getMaxMethodResults(method)
 *   - getQueryWhereSql(config)
 *   - getQueryOffsetSql(config)
 */

'use strict';

const { expect, makeConfig, makeDb, cfg } = require('../../db_query_builder.test.js');

// A deep OFFSET makes the database walk and discard every skipped row, so an
// uncapped page number is a cheap way to tie it up; getQuery caps the offset.
describe('getQuery() API OFFSET cap', function () {
    // A synchronous stub query-builder so getQuery does not hit the DB. getQuery
    // sets config.data.sql.apiOffset BEFORE invoking this[data.method].
    function makeDbWithProbe() {
        const db = makeDb();
        db.probeMethod = () => ['SELECT 1', [], 0];
        return db;
    }

    it('caps apiOffset at 100000 for a huge page (query-complexity DoS guard)', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '999999', limit: '100' } });
        await db.getQuery(config);
        expect(config.data.sql.apiOffset).to.equal(100000);
    });

    it('leaves a normal page offset uncapped', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '3', limit: '20' } });
        await db.getQuery(config);
        expect(config.data.sql.apiOffset).to.equal(40); // (3 - 1) * 20
    });

    it('never produces a negative or NaN offset for a bogus page', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '-5', limit: '20' } });
        await db.getQuery(config);
        // page clamps to >=1, so offset is 0
        expect(config.data.sql.apiOffset).to.equal(0);
    });
});

describe('getQuery() explorer start guard', function () {
    // The explorer branch is selected by the TOP-LEVEL config.type, not data.type, so
    // these build the config directly rather than through cfg(). getBalances is one of
    // the fetch-and-slice methods whose sql.limit is start+length, and getQueryOffsets
    // returns early for it, so no DB is touched.
    function explorerConfig(query) {
        return makeConfig({ type: 'explorer', data: { method: 'getBalances', type: null, query } });
    }
    function makeDbWithProbe() {
        const db = makeDb();
        db.getBalances = () => ['SELECT 1', [], 0];
        return db;
    }

    // sql.limit is string-concatenated into `LIMIT ` + sql.limit at ~40 sites, so a
    // NaN here is `LIMIT NaN`: a rejected query, answered 5xx on an unauthenticated
    // read route. Pre-guard these two cases produced the string "NaN".
    ['abc', '7junk', '1e999'].forEach((bad) => {
        it(`falls back to start=0 for a non-finite ?start=${JSON.stringify(bad)}`, async function () {
            const db = makeDbWithProbe();
            const config = explorerConfig({ start: bad, length: '10' });
            await db.getQuery(config);
            expect(Number.isFinite(Number(config.data.sql.limit))).to.equal(true);
            expect(Number(config.data.sql.limit)).to.equal(10);
        });
    });

    it('falls back to start=0 for a repeated (array-valued) ?start=', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: ['1', '2'], length: '10' });
        await db.getQuery(config);
        expect(Number.isFinite(Number(config.data.sql.limit))).to.equal(true);
        expect(Number(config.data.sql.limit)).to.equal(10);
    });

    it('leaves normal paging alone', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: '50', length: '10' });
        await db.getQuery(config);
        expect(Number(config.data.sql.limit)).to.equal(60);
    });
});
