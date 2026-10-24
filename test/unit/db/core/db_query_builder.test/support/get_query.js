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

// A deep OFFSET makes the database walk and discard every skipped row, so a page
// past the cap is refused rather than clamped onto the capped page's rows.
describe('getQuery() API OFFSET cap', function () {
    // A synchronous stub query-builder so getQuery does not hit the DB. getQuery
    // sets config.data.sql.apiOffset BEFORE invoking this[data.method].
    function makeDbWithProbe() {
        const db = makeDb();
        db.probeMethod = () => ['SELECT 1', [], 0];
        return db;
    }

    it('refuses a page past the 100000-row OFFSET cap with 400 PAGE_TOO_DEEP', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '999999', limit: '100' } });
        const err = await db.getQuery(config).then(() => null, (e) => e);
        expect(err && err.name).to.equal('DbInputError');
        expect(err.code).to.equal('PAGE_TOO_DEEP');
    });

    it('serves the last page inside the cap and refuses the next one', async function () {
        const db = makeDbWithProbe();
        const inside = cfg('probeMethod', 'api', { query: { page: '14286', limit: '7' } });
        await db.getQuery(inside);
        expect(inside.data.sql.apiOffset).to.equal(99995);
        const past = cfg('probeMethod', 'api', { query: { page: '14287', limit: '7' } });
        const err = await db.getQuery(past).then(() => null, (e) => e);
        expect(err && err.code).to.equal('PAGE_TOO_DEEP');
    });

    it('leaves a normal page offset uncapped', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '3', limit: '20' } });
        await db.getQuery(config);
        expect(config.data.sql.apiOffset).to.equal(40); // (3 - 1) * 20
    });

    it('refuses a bogus page with 400 INVALID_PAGE instead of reading page 1', async function () {
        const db = makeDbWithProbe();
        for (const page of ['-5', '0', 'abc', '1.5', '1e3', ['1', '2']]) {
            const config = cfg('probeMethod', 'api', { query: { page, limit: '20' } });
            const err = await db.getQuery(config).then(() => null, (e) => e);
            expect(err && err.code, JSON.stringify(page)).to.equal('INVALID_PAGE');
        }
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
        it(`refuses a non-finite ?start=${JSON.stringify(bad)}`, async function () {
            const db = makeDbWithProbe();
            const config = explorerConfig({ start: bad, length: '10' });
            let error;
            try { await db.getQuery(config); } catch(err) { error = err; }
            expect(error).to.have.property('code', 'INVALID_START');
        });
    });

    it('refuses a repeated (array-valued) ?start=', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: ['1', '2'], length: '10' });
        let error;
        try { await db.getQuery(config); } catch(err) { error = err; }
        expect(error).to.have.property('code', 'INVALID_START');
    });

    it('leaves normal paging alone', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: '50', length: '10' });
        await db.getQuery(config);
        expect(Number(config.data.sql.limit)).to.equal(60);
    });
});
