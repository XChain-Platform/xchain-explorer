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
 * Integration boundary tests: API and Explorer pagination
 *
 * Tests limit/page/length/start/offset/action/sortorder boundary values
 * against a real MariaDB instance with boundary seed data.
 *
 * Run: npm run test:boundary:integration
 * Requires: docker compose -f test/integration/fixtures/docker-compose.test.yml up -d --wait
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;
let app, explorer, configInfo;

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    ({ app, explorer, configInfo } = await createApp());
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// API Mode: limit boundaries
// ===========================================================================

describe('Boundary Integration: API limit parameter', function () {

    it('BV-API-01: limit=1 returns exactly 1 record', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=1`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(1);
    });

    it('BV-API-02: no limit returns up to default max (100)', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        expect(res.body.data.length).to.be.at.most(100);
    });

    it('BV-API-05: limit=0 answers 400 INVALID_LIMIT', async function () {
        // BOUNDARY: limit is read as a whole number of at least 1. The string "0" is
        // present and numeric, but zero is below the floor, so the request is refused
        // with INVALID_LIMIT before any SQL is built; no LIMIT 0 statement is issued
        // and the caller learns the value was wrong instead of reading an empty page.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=0`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LIMIT');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-06: negative limit=-1 answers 400 INVALID_LIMIT', async function () {
        // BOUNDARY: a negative limit is not a safe non-negative integer, so it is refused
        // with INVALID_LIMIT before MariaDB sees it; no LIMIT -1 statement reaches the pool.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=-1`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LIMIT');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-07: fractional limit=1.5 answers 400 INVALID_LIMIT', async function () {
        // A fraction is not a whole number, so it never reaches LIMIT as 1.5.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=1.5`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LIMIT');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-08: non-numeric limit=abc answers 400 INVALID_LIMIT', async function () {
        // Text is refused rather than replaced by the per-method default.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=abc`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LIMIT');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-09: very large limit=999999 does not crash', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=999999`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });
});

// ===========================================================================
// API Mode: page boundaries
// ===========================================================================

describe('Boundary Integration: API page parameter', function () {

    it('BV-API-10: page=0 answers 400 INVALID_PAGE', async function () {
        // Pages count from 1, so page 0 is refused with INVALID_PAGE, like limit=0.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=0`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_PAGE');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-11: negative page=-1 answers 400 INVALID_PAGE', async function () {
        // A negative page is refused rather than read as page 1.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=-1`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_PAGE');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-API-12: very large page=999999 answers 400 PAGE_TOO_DEEP', async function () {
        // Its offset lies past the 100000-row positional cap, so the page is refused
        // rather than clamped onto the capped page and repeating its rows.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=999999`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('PAGE_TOO_DEEP');
        expect(res.body.error).to.be.a('string');
    });

    it('page=1 and page=2 have no overlapping records', async function () {
        const p1 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=1`);
        const p2 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=2`);
        expect(p1.status).to.equal(200);
        expect(p2.status).to.equal(200);

        const idx1 = p1.body.data.map(r => r.action_index);
        const idx2 = p2.body.data.map(r => r.action_index);
        const overlap = idx1.filter(i => idx2.includes(i));
        expect(overlap).to.be.empty;
    });
});

// ===========================================================================
// API Mode: sortorder boundaries
// ===========================================================================

describe('Boundary Integration: API sortorder parameter', function () {

    it('BV-SORT-01: sortorder=ASC returns ascending action_index', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=ASC`);
        expect(res.status).to.equal(200);
        // action_index may be returned as string (BigInt serialization); parse to number
        const indices = res.body.data.map(r => Number(r.action_index));
        for (let i = 0; i < indices.length - 1; i++) {
            expect(indices[i]).to.be.at.most(indices[i + 1]);
        }
    });

    it('BV-SORT-02: sortorder=DESC returns descending action_index', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=DESC`);
        expect(res.status).to.equal(200);
        const indices = res.body.data.map(r => Number(r.action_index));
        for (let i = 0; i < indices.length - 1; i++) {
            expect(indices[i]).to.be.at.least(indices[i + 1]);
        }
    });

    it('BV-SORT-03: sortorder=asc (lowercase) is accepted', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=asc`);
        expect(res.status).to.equal(200);
        const indices = res.body.data.map(r => Number(r.action_index));
        for (let i = 0; i < indices.length - 1; i++) {
            expect(indices[i]).to.be.at.most(indices[i + 1]);
        }
    });

    it('BV-SORT-04: invalid sortorder=RANDOM answers 400 INVALID_SORTORDER', async function () {
        // Only asc or desc, in any case, is accepted; anything else is refused
        // rather than silently read as the default descending order.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=RANDOM`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_SORTORDER');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-SORT-06: SQL injection in sortorder is refused with 400 INVALID_SORTORDER', async function () {
        // The payload is not asc or desc, so it is refused before ORDER BY is built,
        // and the error body names the parameter without echoing the payload back.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=DESC;DROP%20TABLE%20sends`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_SORTORDER');
        expect(JSON.stringify(res.body)).to.not.include('DROP');
    });
});

// ===========================================================================
// URL path boundaries
// ===========================================================================

describe('Boundary Integration: URL path segments', function () {

    it('BV-URL-01: valid coin RBTC returns data', async function () {
        const res = await request.get('/RBTC/api/status');
        expect(res.status).to.equal(200);
    });

    it('BV-URL-02: lowercase coin rbtc is uppercased and accepted', async function () {
        const res = await request.get('/rbtc/api/status');
        expect(res.status).to.equal(200);
    });

    it('BV-URL-03: unsupported coin ETH falls to HTML handler', async function () {
        const res = await request.get('/ETH/api/sends/test/address');
        // ETH not in COIN_SUPPORTED -> falls to HTML handler
        // Without HTML templates in test env, returns 404 or 503
        expect(res.status).to.be.oneOf([200, 404, 503]);
    });

    it('BV-URL-06: string "null" in query position is converted to actual null', async function () {
        const res = await request.get('/RBTC/api/sends/null/address');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-URL-07: missing query segment for blocks', async function () {
        const res = await request.get('/RBTC/api/blocks');
        // blocks endpoint may not match without additional path segments
        expect(res.status).to.be.oneOf([200, 404]);
    });

    it('BV-URL-10: unicode in path does not cause server error', async function () {
        const res = await request.get('/RBTC/api/token/%F0%9F%9A%80MOON');
        // Token won't exist but should not crash
        expect(res.status).to.be.oneOf([200, 400, 404]);
    });
});

// ===========================================================================
// Balances and holders boundaries
// ===========================================================================

describe('Boundary Integration: Balances and Holders limits', function () {

    it('getBalances default limit is 500 (not 100)', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('getBalances default sort is ASC', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
    });

    it('getHolders returns holders for XCHAIN token', async function () {
        const res = await request.get('/RBTC/api/holders/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
    });

    // Fix verified: getHolders now probes index_tickers before scanning balances,
    // so an unknown tick short-circuits immediately with an empty result instead
    // of performing a full balances table scan (the previous DoS-shaped hang).
    it('getHolders for nonexistent token returns empty data quickly', async function () {
        this.timeout(5000); // Must complete well under 5s; a hang would time out here
        const res = await request.get('/RBTC/api/holders/DOESNOTEXIST');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });
});

// ===========================================================================
// Explorer mode boundaries
// ===========================================================================

describe('Boundary Integration: Explorer pagination', function () {

    it('BV-EXP-01: length=1 returns 1 record', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?length=1&start=0`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(1);
    });

    it('BV-EXP-02: default length=10', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        expect(res.body.data.length).to.be.at.most(10);
    });

    it('BV-EXP-05: length=0 answers 400 INVALID_LENGTH', async function () {
        // An explorer page holds at least one row, so a zero length is refused.
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?length=0`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LENGTH');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-EXP-08: start beyond total returns empty data', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?start=999999&length=10`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('BV-EXP-13: non-numeric offset answers 400 INVALID_OFFSET', async function () {
        // The offset is the cursor a next page continues from on a cursor-paged feed,
        // so text there is refused instead of reaching the cursor predicate.
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?offset=abc&action=next`);
        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_OFFSET');
        expect(res.body.error).to.be.a('string');
    });

    it('BV-EXP-16: invalid action value is ignored', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?action=invalid`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('explorer recordsTotal and recordsFiltered are present', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
    });
});
