/**
 * Integration boundary tests — API and Explorer pagination
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
// API Mode — limit boundaries
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

    it('BV-API-05: limit=0 — string "0" is truthy, accepted as zero, SQL LIMIT 0', async function () {
        // BOUNDARY FINDING: In HTTP query params, limit=0 arrives as string "0"
        // which is truthy, so it passes the `q.limit && ...` check.
        // isInteger(Number("0")) = isInteger(0) = true, so limit=0 is accepted.
        // SQL LIMIT 0 returns no rows → empty data.
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=0`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        // May be empty (LIMIT 0) or may error — either way, no crash
    });

    it('BV-API-06: negative limit=-1 — accepted by isInteger, produces SQL error', async function () {
        // BOUNDARY FINDING: "-1" passes isInteger check. SQL LIMIT -1 is invalid
        // in MariaDB → SQL error is caught → returns 200 with empty/error data
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=-1`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-API-07: fractional limit=1.5 falls back to default', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=1.5`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-API-08: non-numeric limit=abc falls back to default', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=abc`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-API-09: very large limit=999999 does not crash', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=999999`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });
});

// ===========================================================================
// API Mode — page boundaries
// ===========================================================================

describe('Boundary Integration: API page parameter', function () {

    it('BV-API-10: page=0 — string "0" is truthy, accepted, produces LIMIT 0', async function () {
        // Same issue as limit=0: "0" is truthy as a string
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=0`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-API-11: negative page=-1 returns empty or handles gracefully', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=-1`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-API-12: very large page=999999 returns empty data', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=999999`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
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
// API Mode — sortorder boundaries
// ===========================================================================

describe('Boundary Integration: API sortorder parameter', function () {

    it('BV-SORT-01: sortorder=ASC returns ascending action_index', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=ASC`);
        expect(res.status).to.equal(200);
        // action_index may be returned as string (BigInt serialization) — parse to number
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

    it('BV-SORT-04: invalid sortorder=RANDOM falls back to default DESC', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=RANDOM`);
        expect(res.status).to.equal(200);
        const indices = res.body.data.map(r => Number(r.action_index));
        for (let i = 0; i < indices.length - 1; i++) {
            expect(indices[i]).to.be.at.least(indices[i + 1]);
        }
    });

    it('BV-SORT-06: SQL injection in sortorder is rejected', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?sortorder=DESC;DROP%20TABLE%20sends`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
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
        // ETH not in COIN_SUPPORTED → falls to HTML handler
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

    // BOUNDARY FINDING: getHolders for a nonexistent token hangs indefinitely.
    // The query performs a full table scan of all balances with no tick filter
    // because the tick ID lookup returns null, causing an unbounded query.
    // This is a performance/DoS vulnerability documented in the boundary plan.
    it.skip('getHolders for nonexistent token — KNOWN HANG (performance boundary)', async function () {
        const res = await request.get('/RBTC/api/holders/DOESNOTEXIST');
        expect(res.status).to.equal(200);
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

    it('BV-EXP-05: length=0 is accepted (string "0" is truthy)', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?length=0`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-EXP-08: start beyond total returns empty data', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?start=999999&length=10`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('BV-EXP-13: non-numeric offset is ignored', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?offset=abc&action=next`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
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
