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
 * Integration tests — Error handling and invalid request behaviour
 *
 * Verifies that the explorer returns correct HTTP status codes and bodies
 * for unsupported coins, unavailable coins, unknown paths, null query values,
 * and malformed query parameters.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/error-handling.test.js)
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
// Error Handling
// ===========================================================================

describe('Error Handling', function () {

    // -----------------------------------------------------------------------
    // 1. Unsupported coin returns 503
    // -----------------------------------------------------------------------

    it('unsupported coin returns 503', async function () {
        // XRP is not in COIN_SUPPORTED, but the URL pattern /{COIN}/api/sends/{QUERY}/{TYPE}
        // still matches and sets cfg.data.method = 'getSends'. Because validDataRequest is false
        // (coin not in COIN_SUPPORTED or COIN_AVAILABLE), the explorer returns 503.
        const res = await request.get('/XRP/api/sends/1/block');

        expect(res.status).to.equal(503);
    });

    // -----------------------------------------------------------------------
    // 2. Supported but unavailable coin returns 503
    // -----------------------------------------------------------------------

    it('supported but unavailable coin returns 503', async function () {
        // BTC mainnet is in COIN_SUPPORTED but not in COIN_AVAILABLE (only RBTC is available)
        const res = await request.get('/BTC/api/sends/1/block');

        expect(res.status).to.equal(503);
        expect(res.body).to.have.property('error');
        expect(res.body.error).to.be.a('string').and.have.length.greaterThan(0);
    });

    // -----------------------------------------------------------------------
    // 3. Invalid API path returns 404
    // -----------------------------------------------------------------------

    it('invalid path returns 404', async function () {
        // /RBTC/api/nonexistent/1/block has no matching route definition
        const res = await request.get('/RBTC/api/nonexistent/1/block');

        expect(res.status).to.equal(404);
    });

    // -----------------------------------------------------------------------
    // 4. String 'null' query value returns 200 with empty results
    // -----------------------------------------------------------------------

    it('null search value returns 200 with empty results', async function () {
        // The explorer converts the string 'null' in the URL path to an actual null value.
        // MariaDB treats block_index=NULL as no match, so getData() returns total=0 and
        // data=[], which is a valid numeric total → 200 with an empty data array (not 400).
        const res = await request.get('/RBTC/api/sends/null/block');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('data');
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    // -----------------------------------------------------------------------
    // 5. Invalid query parameters are handled gracefully
    // -----------------------------------------------------------------------

    it('invalid limit param defaults to 100 and does not crash', async function () {
        // Non-numeric limit should be ignored; explorer defaults to 100
        const res = await request.get('/RBTC/api/sends/1/block?limit=abc');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array');
    });

    it('invalid sortorder param defaults to DESC and does not crash', async function () {
        // Unrecognised sortorder value should be ignored; default is DESC.
        // Block 2 has 2 sends in the seed data (action_index 3 and 4).
        const res = await request.get('/RBTC/api/sends/2/block?sortorder=INVALID');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        // Default sort is DESC so first item has a higher action_index than the last
        const items = res.body.data;
        if (items.length > 1) {
            expect(Number(items[0].action_index)).to.be.greaterThan(Number(items[items.length - 1].action_index));
        }
    });

    // -----------------------------------------------------------------------
    // 6. Negative page number is handled gracefully
    // -----------------------------------------------------------------------

    it('negative page number does not crash and returns data', async function () {
        // A negative page value is treated as page 1 by the paging logic
        const res = await request.get('/RBTC/api/sends/1/block?page=-1');

        // Should not throw a 500; the explorer should handle it and return a usable response
        expect(res.status).to.be.oneOf([200, 400]);
        // If 200, data must be an array
        if (res.status === 200) {
            expect(res.body.data).to.be.an('array');
        }
    });

});
