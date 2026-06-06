/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration tests — Response format, headers, and field conventions
 *
 * Verifies Content-Type, custom headers, alphabetical key ordering, explorer
 * array-of-arrays format, runtime field, null-vs-"null" correctness, and
 * numeric precision for amount fields.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/response-format.test.js)
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let request;
let app, explorer, configInfo;

// Seed address with known balances
const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
// Response Format
// ===========================================================================

describe('Response Format', function () {

    // -----------------------------------------------------------------------
    // 1. API responses have correct Content-Type
    // -----------------------------------------------------------------------

    it('API responses have correct Content-Type', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('json');
    });

    // -----------------------------------------------------------------------
    // 2. Custom headers are present
    // -----------------------------------------------------------------------

    it('XChain-Explorer-Version header is present', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.headers).to.have.property('xchain-explorer-version');
        expect(res.headers['xchain-explorer-version']).to.be.a('string').and.have.length.greaterThan(0);
    });

    it('Access-Control-Allow-Origin header is *', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.headers).to.have.property('access-control-allow-origin', '*');
    });

    it('XChain-Runtime-Ms header is present and numeric', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.headers).to.have.property('xchain-runtime-ms');
        const ms = Number(res.headers['xchain-runtime-ms']);
        expect(ms).to.be.a('number').and.to.be.at.least(0);
    });

    // -----------------------------------------------------------------------
    // 3. API response properties are alphabetically sorted
    // -----------------------------------------------------------------------

    it('API response properties are alphabetically sorted', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        // Top-level keys except the trailing `runtime` must be alphabetically sorted
        const bodyKeys       = Object.keys(res.body);
        const withoutRuntime = bodyKeys.filter(k => k !== 'runtime');
        expect(withoutRuntime).to.deep.equal([...withoutRuntime].sort());
        // `runtime` is always appended last
        expect(bodyKeys[bodyKeys.length - 1]).to.equal('runtime');

        // Each data row must have fully sorted keys
        for (const row of res.body.data) {
            const rowKeys = Object.keys(row);
            expect(rowKeys).to.deep.equal([...rowKeys].sort());
        }
    });

    // -----------------------------------------------------------------------
    // 4. Explorer responses are NOT alphabetically sorted (array-of-arrays)
    // -----------------------------------------------------------------------

    it('explorer responses return array-of-arrays in data', async function () {
        const res = await request.get('/RBTC/explorer/sends/5/block');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        // Explorer data rows are arrays, not objects
        expect(res.body.data[0]).to.be.an('array');
    });

    // -----------------------------------------------------------------------
    // 5. runtime field is present in API responses
    // -----------------------------------------------------------------------

    it('runtime field is present in API responses', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('runtime');
        // Runtime is a string like "42ms" or "1s 200ms"
        expect(res.body.runtime).to.be.a('string');
        expect(res.body.runtime).to.match(/\d+/);
    });

    // -----------------------------------------------------------------------
    // 6. null fields are actual null, not the string "null"
    // -----------------------------------------------------------------------

    it('null fields are actual null not string "null"', async function () {
        // action_index 9 is a send with no memo_id (memo_id is NULL in the seed)
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        // Find the send with action_index 9 which has no memo
        const send9 = res.body.data.find(r => Number(r.action_index) === 9);
        expect(send9, 'expected to find send with action_index 9').to.exist;
        expect(send9.memo).to.equal(null);
        expect(send9.memo).to.not.equal('null');
    });

    // -----------------------------------------------------------------------
    // 7. Numeric precision preserved for amounts
    // -----------------------------------------------------------------------

    it('amount values are strings with 8 decimal places', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        for (const row of res.body.data) {
            expect(row.amount).to.be.a('string');
            // Should have exactly 8 decimal places (e.g. "500000.00000000")
            expect(row.amount).to.match(/^\d+\.\d{8}$/);
        }
    });

});
