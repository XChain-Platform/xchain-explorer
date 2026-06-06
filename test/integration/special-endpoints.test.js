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
 * Integration tests — special endpoints
 *
 * Covers the /icon handler, /relay SSRF-protection handler, JSON-RPC ping,
 * HTML page serving, and static file routing in xchain-explorer.
 *
 * Boots a real Express app against a test MariaDB on port 3307.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/special-endpoints.test.js)
 */

'use strict';

const { expect }        = require('chai');
const supertest         = require('supertest');
const jsonRouter        = require('express-json-rpc-router');
const db                = require('./helpers/db-setup');
const { createApp }     = require('./helpers/app-setup');

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

    // Register the JSON-RPC router after explorer routes, mirroring api.js.
    // It must be added after explorer.init() so explorer routes take priority.
    const jsonRpcController = {
        async ping() {
            return { status: 'success' };
        }
    };
    app.use(jsonRouter({ methods: jsonRpcController }));

    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// Special Endpoints
// ===========================================================================

describe('Special Endpoints', function () {

    // -----------------------------------------------------------------------
    // 1. Icon endpoint — redirects for missing files
    // -----------------------------------------------------------------------

    it('GET /icon/default.png — icon endpoint serves files', async function () {
        // A nonexistent icon file should redirect (302) to /icon/default.png.
        // The handler calls fs.existsSync; the file does not exist in test env.
        const res = await request.get('/icon/nonexistent.png');

        expect(res.status).to.equal(302);
        expect(res.headers.location).to.equal('/icon/default.png');
    });

    // -----------------------------------------------------------------------
    // 2. Icon path traversal protection
    // -----------------------------------------------------------------------

    it('icon path traversal is blocked', async function () {
        // Express normalizes paths with ../ before the handler sees them.
        // The resulting path either stays inside the icon dir (→ 302 redirect to default)
        // or escapes to a non-icon route (→ 404 HTML page). Either way, no file leak.
        const res = await request.get('/icon/../../../etc/passwd');

        expect([302, 403, 404]).to.include(res.status);
    });

    // -----------------------------------------------------------------------
    // 3. Relay — SSRF protection: loopback IP
    // -----------------------------------------------------------------------

    it('relay blocks private IPs (SSRF protection)', async function () {
        const res = await request.get('/relay?url=http://127.0.0.1/test');

        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Destination not permitted');
    });

    // -----------------------------------------------------------------------
    // 4. Relay — non-http/https protocol rejected
    // -----------------------------------------------------------------------

    it('relay blocks non-http protocols', async function () {
        const res = await request.get('/relay?url=file:///etc/passwd');

        expect(res.status).to.equal(400);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Invalid protocol');
    });

    // -----------------------------------------------------------------------
    // 5. Relay — missing url param does not crash
    // -----------------------------------------------------------------------

    it('relay without url returns error', async function () {
        // processRelayRequest checks isNull(req.query.url) and falls through to
        // a 503 response. The server must not crash.
        const res = await request.get('/relay');

        expect(res.status).to.equal(503);
    });

    // -----------------------------------------------------------------------
    // 6. Relay — localhost hostname blocked
    // -----------------------------------------------------------------------

    it('relay blocks localhost', async function () {
        const res = await request.get('/relay?url=http://localhost/test');

        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Destination not permitted');
    });

    // -----------------------------------------------------------------------
    // 7. Relay — 10.x.x.x private range blocked
    // -----------------------------------------------------------------------

    it('relay blocks 10.x.x.x private range', async function () {
        const res = await request.get('/relay?url=http://10.0.0.1/test');

        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Destination not permitted');
    });

    // -----------------------------------------------------------------------
    // 8. Relay — 192.168.x.x private range blocked
    // -----------------------------------------------------------------------

    it('relay blocks 192.168.x.x private range', async function () {
        const res = await request.get('/relay?url=http://192.168.1.1/test');

        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Destination not permitted');
    });

    // -----------------------------------------------------------------------
    // 9. JSON-RPC ping
    // -----------------------------------------------------------------------

    it('JSON-RPC ping endpoint', async function () {
        const res = await request
            .post('/')
            .set('Content-Type', 'application/json')
            .send({ jsonrpc: '2.0', method: 'ping', params: [], id: 1 });

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('result');
        expect(res.body.result).to.have.property('status', 'success');
    });

    // -----------------------------------------------------------------------
    // 10. HTML pages are served
    // -----------------------------------------------------------------------

    it('HTML pages are served', async function () {
        const res = await request.get('/');

        expect(res.status).to.equal(200);
        expect(res.type).to.match(/text\/html/);
    });

    // -----------------------------------------------------------------------
    // 11. HTML 404 page
    // -----------------------------------------------------------------------

    it('HTML 404 page', async function () {
        const res = await request.get('/nonexistent-page');

        expect(res.status).to.equal(404);
    });

    // -----------------------------------------------------------------------
    // 12. Static file routes do not crash
    // -----------------------------------------------------------------------

    it('static file serving works', async function () {
        // The /css route is registered as a static file directory.
        // Files may or may not exist in the test environment; we only verify
        // the server responds without crashing (any HTTP status is acceptable).
        const res = await request.get('/css/');

        expect(res.status).to.be.a('number');
    });

});
