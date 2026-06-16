'use strict';

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
 * Smoke tests — Static file serving and HTML routes (SM-12, SM-14, SM-15)
 *
 * Requires MariaDB on port 3307 (start with: npm run test:integration:up).
 * Validates static asset serving, HTML page delivery, and 404 handling.
 *
 * Run: npm run test:smoke:connected
 */

const { expect }     = require('chai');
const supertest      = require('supertest');
const db             = require('../../integration/helpers/db-setup');
const { createApp }  = require('../../integration/helpers/app-setup');

let request, app, explorer, configInfo;

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

// ---------------------------------------------------------------------------
// SM-12: Static file serving works
// ---------------------------------------------------------------------------

describe('SM-12: Static file serving', function () {

    it('GET /json/ or a known static path responds without server error', async function () {
        const res = await request.get('/json/');

        // Static directories may return 200 (with index), 403 (forbidden directory listing),
        // or 404 (no index file) — but never 500
        expect(res.status).to.not.equal(500);
    });

    it('GET /css/ responds without server error', async function () {
        const res = await request.get('/css/');
        expect(res.status).to.not.equal(500);
    });

});

// ---------------------------------------------------------------------------
// SM-14: HTML home page loads
// ---------------------------------------------------------------------------

describe('SM-14: HTML pages load', function () {

    it('GET /RBTC/ returns an HTML page', async function () {
        const res = await request.get('/RBTC/');

        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.match(/html/);
        expect(res.text).to.have.length.greaterThan(0);
    });

    it('GET / returns a response (home page)', async function () {
        const res = await request.get('/');

        // Home page should return 200 with HTML
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.match(/html/);
    });

    it('GET /about returns a response', async function () {
        const res = await request.get('/about');
        expect(res.status).to.equal(200);
    });

});

// ---------------------------------------------------------------------------
// SM-15: 404 handling works
// ---------------------------------------------------------------------------

describe('SM-15: 404 and error handling', function () {

    it('GET /RBTC/nonexistent-route does not crash the server', async function () {
        const res = await request.get('/RBTC/nonexistent-route-xyz');

        // Should return 404 or serve the 404 page (200 with 404 content)
        // The key assertion is that it does NOT return 500
        expect(res.status).to.not.equal(500);
    });

    it('GET /completely/invalid/deep/path does not crash', async function () {
        const res = await request.get('/completely/invalid/deep/path');
        expect(res.status).to.not.equal(500);
    });

});
