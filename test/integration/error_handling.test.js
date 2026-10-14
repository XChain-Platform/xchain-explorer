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
 * Integration tests: Error handling and invalid request behaviour
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

let request;
let app, explorer, configInfo;

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

describe('Error Handling', function () {

    it('unsupported coin returns 503', async function () {
        // XRP is not in COIN_SUPPORTED, but the URL pattern /{COIN}/api/sends/{QUERY}/{TYPE}
        // still matches and sets cfg.data.method = 'getSends'. Because validDataRequest is false
        // (coin not in COIN_SUPPORTED or COIN_AVAILABLE), the explorer returns 503.
        const res = await request.get('/XRP/api/sends/1/block');

        expect(res.status).to.equal(503);
    });

    it('supported but unavailable coin returns 503', async function () {
        // BTC mainnet is in COIN_SUPPORTED but not in COIN_AVAILABLE (only RBTC is available)
        const res = await request.get('/BTC/api/sends/1/block');

        expect(res.status).to.equal(503);
        expect(res.body).to.have.property('error');
        expect(res.body.error).to.be.a('string').and.have.length.greaterThan(0);
    });

    it('invalid path returns 404', async function () {
        // /RBTC/api/nonexistent/1/block has no matching route definition
        const res = await request.get('/RBTC/api/nonexistent/1/block');

        expect(res.status).to.equal(404);
    });

    it('null search value returns 200 with empty results', async function () {
        // The explorer converts the string 'null' in the URL path to an actual null value.
        // MariaDB treats block_index=NULL as no match, so getData() returns total=0 and
        // data=[], which is a valid numeric total → 200 with an empty data array (not 400).
        const res = await request.get('/RBTC/api/sends/null/block');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('data');
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

});

describe('Error Handling', function () {

    it('invalid limit param answers 400 INVALID_LIMIT', async function () {
        // A non-integer limit is refused before any SQL is built. Silently
        // defaulting it would hand the caller a page size it never asked for,
        // so a client paging with a typo would read the wrong rows.
        const res = await request.get('/RBTC/api/sends/1/block?limit=abc');

        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_LIMIT');
        expect(res.body.error).to.be.a('string');
    });

    it('invalid sortorder param answers 400 INVALID_SORTORDER', async function () {
        // Only asc or desc (any case) reaches ORDER BY; anything else is refused.
        // Falling back to DESC would let a misspelled ASC page read in reverse
        // order without any sign that the parameter was ignored.
        const res = await request.get('/RBTC/api/sends/2/block?sortorder=INVALID');

        expect(res.status).to.equal(400);
        expect(res.body.code).to.equal('INVALID_SORTORDER');
        expect(res.body.error).to.be.a('string');
    });

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
