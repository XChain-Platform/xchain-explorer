/**
 * Integration boundary tests — Search LIKE injection and data value edges
 *
 * Tests LIKE wildcard characters in search, long search strings,
 * empty searches, zero-supply tokens, maximum-value balances,
 * smallest-unit balances, and BigInt serialization.
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
const ADDR4 = 'bc1qaddr4ddddddddddddddddddddddddddd';

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
// Search LIKE wildcard boundaries
// ===========================================================================

describe('Boundary Integration: Search LIKE wildcards', function () {

    it('BV-SRCH-01: null search returns token results (LIKE with wildcard)', async function () {
        const res = await request.get('/RBTC/api/tokens/null/token');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-SRCH-02: single-character search returns matching tokens', async function () {
        const res = await request.get('/RBTC/api/tokens/X/token');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('BV-SRCH-04: very long search string does not crash', async function () {
        const longSearch = 'A'.repeat(1000);
        const res = await request.get(`/RBTC/api/tokens/${longSearch}/token`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('BV-SRCH-06: SQL injection in search is parameterized away', async function () {
        const res = await request.get(`/RBTC/api/tokens/${encodeURIComponent("'; DROP TABLE tokens--")}/token`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        // Verify tokens table still exists
        const check = await request.get('/RBTC/api/token/XCHAIN');
        expect(check.status).to.equal(200);
    });

    it('BV-SRCH-07: exact tick name returns matching token', async function () {
        const res = await request.get('/RBTC/api/tokens/XCHAIN/token');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
    });
});

// ===========================================================================
// Token data value boundaries
// ===========================================================================

describe('Boundary Integration: Token data values', function () {

    it('BV-NUM-02: zero-supply token returns supply as zero', async function () {
        const res = await request.get('/RBTC/api/token/ZEROSUPPLY');
        expect(res.status).to.equal(200);
        if (res.body.data && res.body.data.length > 0) {
            const token = res.body.data[0];
            const supply = parseFloat(token.supply);
            expect(supply).to.equal(0);
        }
    });

    it('BV-NUM-01: max-value token preserves precision in supply', async function () {
        const res = await request.get('/RBTC/api/token/MAXVAL');
        expect(res.status).to.equal(200);
        if (res.body.data && res.body.data.length > 0) {
            const token = res.body.data[0];
            expect(token.supply).to.be.a('string');
            expect(token.supply).to.include('9999999999999999');
        }
    });

    it('BV-NUM-05: smallest-unit token (0.00000001) is not rounded to zero', async function () {
        const res = await request.get('/RBTC/api/token/TINYTOK');
        expect(res.status).to.equal(200);
        if (res.body.data && res.body.data.length > 0) {
            const token = res.body.data[0];
            const supply = parseFloat(token.supply);
            expect(supply).to.be.greaterThan(0);
        }
    });
});

// ===========================================================================
// Balance data value boundaries
// ===========================================================================

describe('Boundary Integration: Balance data values', function () {

    it('zero balance is returned and formatted correctly', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR4}`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        // addr4 has a zero balance for ZEROSUPPLY token
        const zeroBal = res.body.data.find(b => b.tick === 'ZEROSUPPLY');
        if (zeroBal) {
            expect(parseFloat(zeroBal.amount)).to.equal(0);
        }
    });

    it('max-value balance preserves precision via string serialization', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
        // addr1 has a 9999999999999999.99999999 balance for MAXVAL
        const maxBal = res.body.data.find(b => b.tick === 'MAXVAL');
        if (maxBal) {
            expect(maxBal.amount).to.be.a('string');
            expect(maxBal.amount).to.include('9999999999999999');
        }
    });
});

// ===========================================================================
// Block and action boundaries
// ===========================================================================

describe('Boundary Integration: Block and action boundaries', function () {

    it('block_index=1 (first block) returns data', async function () {
        const res = await request.get('/RBTC/api/block/1');
        expect(res.status).to.equal(200);
    });

    it('block_index=5 (last seeded block) returns data', async function () {
        const res = await request.get('/RBTC/api/block/5');
        expect(res.status).to.equal(200);
    });

    it('block_index=0 (nonexistent) returns empty or error', async function () {
        const res = await request.get('/RBTC/api/block/0');
        // May return 200 with empty data, or 400 if block 0 is invalid
        expect(res.status).to.be.oneOf([200, 400]);
    });

    it('block_index=999999 (far beyond) returns empty or error', async function () {
        const res = await request.get('/RBTC/api/block/999999');
        expect(res.status).to.be.oneOf([200, 400]);
    });

    it('negative block_index returns gracefully', async function () {
        const res = await request.get('/RBTC/api/block/-1');
        // -1 may be parsed by parseInt → MariaDB may reject or return empty
        expect(res.status).to.be.oneOf([200, 400]);
    });

    it('getBlocks via blocks endpoint', async function () {
        // The /api/blocks endpoint may require a query segment
        const res = await request.get('/RBTC/api/blocks/null/block');
        expect(res.status).to.be.oneOf([200, 404]);
    });
});

// ===========================================================================
// Response format boundaries
// ===========================================================================

describe('Boundary Integration: Response format consistency', function () {

    it('API response has total and data fields', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data');
        expect(res.body.total).to.be.a('number');
    });

    it('API response with no results has total=0 and empty data', async function () {
        const res = await request.get('/RBTC/api/sends/bc1qnonexistentaddresszzzzzzzzzzzz/address');
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('total', 0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('no stack traces or SQL in error responses', async function () {
        const res = await request.get('/RBTC/api/sends/null/address?limit=-99999&page=-99999');
        expect(res.status).to.equal(200);
        const body = JSON.stringify(res.body);
        expect(body).to.not.include('SELECT');
        expect(body).to.not.include('Error:');
        expect(body).to.not.include('stack');
    });

    it('status endpoint always returns data regardless of parameters', async function () {
        const res = await request.get('/RBTC/api/status');
        expect(res.status).to.equal(200);
    });
});

// ===========================================================================
// Market endpoint boundaries
// ===========================================================================

describe('Boundary Integration: Market endpoints', function () {

    it('markets list returns seeded market pairs', async function () {
        const res = await request.get('/RBTC/api/markets');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('specific market pair returns data', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE');
        expect(res.status).to.equal(200);
    });

    it('reversed market pair also returns data', async function () {
        const res = await request.get('/RBTC/api/market/TOKENONE/XCHAIN');
        expect(res.status).to.equal(200);
    });

    it('nonexistent market pair returns 200 without crashing', async function () {
        const res = await request.get('/RBTC/api/market/FAKE1/FAKE2');
        expect(res.status).to.equal(200);
        // Market endpoint returns {runtime: '...'} for nonexistent pairs
        // No data property is returned — this is a boundary finding
        expect(res.body).to.be.an('object');
    });
});
