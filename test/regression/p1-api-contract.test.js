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
 * P1 Regression Tests: API Contract and Response Format
 *
 * Verifies response shapes, content-types, status codes, headers,
 * key ordering, and the explorer DataTables format contract.
 *
 * Requires: MariaDB on port 3307 (npm run test:integration:up)
 * Run: mocha test/regression/p1-api-contract.test.js --timeout 30000
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';

let request;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

describe('@p1 @contract Content-Type and headers regression', function () {

    it('API responses have JSON content-type', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('json');
    });

    // Note: XChain-Explorer-Version and XChain-Runtime-Ms headers are set by
    // api.js middleware (production entry point), not by XChainExplorer itself.
    // They are NOT present in the test app setup and are verified in smoke tests
    // against a live server instead.

    it('Access-Control-Allow-Origin is *', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.headers['access-control-allow-origin']).to.equal('*');
    });
});

describe('@p1 @contract Alphabetical key ordering regression', function () {

    it('API response top-level keys are sorted (runtime last)', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);
        const bodyKeys = Object.keys(res.body);
        const withoutRuntime = bodyKeys.filter(k => k !== 'runtime');
        expect(withoutRuntime).to.deep.equal([...withoutRuntime].sort());
        expect(bodyKeys[bodyKeys.length - 1]).to.equal('runtime');
    });

    it('each data row has sorted keys', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);
        for (const row of res.body.data) {
            const rowKeys = Object.keys(row);
            expect(rowKeys).to.deep.equal([...rowKeys].sort());
        }
    });
});

describe('@p1 @contract Runtime field regression', function () {

    it('runtime field is a string with digits', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.body).to.have.property('runtime');
        expect(res.body.runtime).to.be.a('string');
        expect(res.body.runtime).to.match(/\d+/);
    });
});

describe('@p1 @contract Null field handling regression', function () {

    it('null fields are actual null not string "null"', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);
        // action_index 9 has no memo
        const send9 = res.body.data.find(r => Number(r.action_index) === 9);
        expect(send9).to.exist;
        expect(send9.memo).to.equal(null);
        expect(send9.memo).to.not.equal('null');
    });
});

describe('@p1 @contract Explorer DataTables format regression', function () {

    it('explorer responses have recordsTotal, recordsFiltered, data', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address`).expect(200);
        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('explorer data rows are arrays not objects', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address`).expect(200);
        if (res.body.data.length > 0) {
            expect(res.body.data[0]).to.be.an('array');
        }
    });

    it('explorer balances return 6-element array rows', async function () {
        const res = await request.get(`/RBTC/explorer/balances/${ADDR1}/address`).expect(200);
        expect(Number(res.body.recordsTotal)).to.be.at.least(1);
        const row = res.body.data[0];
        expect(row).to.be.an('array');
        expect(row.length).to.equal(6);
        expect(row[5]).to.be.null;
    });

    it('explorer blocks return 4-element array rows', async function () {
        const res = await request.get('/RBTC/explorer/blocks/all').expect(200);
        expect(Number(res.body.recordsTotal)).to.be.at.least(10);
        const row = res.body.data[0];
        expect(row).to.be.an('array');
        expect(row.length).to.equal(4);
        // first and last elements are the same block_index
        expect(row[0]).to.equal(row[3]);
    });

    it('explorer pagination honours length parameter', async function () {
        const res = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?start=0&length=3`).expect(200);
        expect(res.body.data.length).to.be.at.most(3);
    });

    it('explorer pagination start offset shifts pages', async function () {
        const p1 = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?start=0&length=2`).expect(200);
        const p2 = await request.get(`/RBTC/explorer/sends/${ADDR1}/address?start=2&length=2`).expect(200);
        const total = Number(p1.body.recordsTotal);
        if (total > 2 && p2.body.data.length > 0) {
            expect(p1.body.data[0]).to.not.deep.equal(p2.body.data[0]);
        }
    });
});

describe('@p1 @contract Empty results regression', function () {

    it('valid query with no matches returns empty array, not error', async function () {
        const res = await request.get('/RBTC/api/sends/NONEXISTENT/token');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });
});

describe('@p1 @contract Special endpoints regression', function () {

    it('icon path traversal is blocked', async function () {
        const res = await request.get('/icon/../../../etc/passwd');
        expect([302, 403, 404]).to.include(res.status);
    });

    it('relay blocks private IPs (SSRF)', async function () {
        const res = await request.get('/relay?url=http://127.0.0.1/test');
        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.equal('Destination not permitted');
    });

    it('relay blocks localhost', async function () {
        const res = await request.get('/relay?url=http://localhost/test');
        expect(res.status).to.equal(403);
    });

    it('relay blocks 10.x private range', async function () {
        const res = await request.get('/relay?url=http://10.0.0.1/test');
        expect(res.status).to.equal(403);
    });

    it('relay blocks 192.168.x private range', async function () {
        const res = await request.get('/relay?url=http://192.168.1.1/test');
        expect(res.status).to.equal(403);
    });

    it('relay blocks non-http protocols', async function () {
        const res = await request.get('/relay?url=file:///etc/passwd');
        expect(res.status).to.equal(400);
    });

    it('relay without url param returns error', async function () {
        const res = await request.get('/relay');
        expect(res.status).to.equal(503);
    });

    it('HTML root page is served', async function () {
        const res = await request.get('/');
        expect(res.status).to.equal(200);
        expect(res.type).to.match(/text\/html/);
    });

    it('HTML 404 for nonexistent pages', async function () {
        const res = await request.get('/nonexistent-page');
        expect(res.status).to.equal(404);
    });
});

// Every error path must return `{ error: <string> }` with a JSON content-type
// so a consumer with a single `response.body.error` handler works uniformly.
// The /file/raw, /relay and /icon handlers previously returned plain text.
describe('@p1 @contract Error responses are JSON envelopes', function () {

    // /file/raw: documented, externally-consumed gated-content endpoint.
    it('/file/raw returns JSON { error } on a non-numeric action_index (400)', async function () {
        const res = await request.get('/RBTC/api/file/not-a-number/raw');
        expect(res.status).to.equal(400);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.be.a('string').with.length.above(0);
    });

    it('/file/raw returns JSON { error } on an unknown coin (404)', async function () {
        const res = await request.get('/ZZZ/api/file/1/raw');
        expect(res.status).to.equal(404);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.be.a('string').with.length.above(0);
    });

    // /relay: SSRF rejection path.
    it('/relay returns JSON { error } on a blocked destination (403)', async function () {
        const res = await request.get('/relay?url=http://127.0.0.1/test');
        expect(res.status).to.equal(403);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.be.a('string').with.length.above(0);
    });

    it('/relay returns JSON { error } when no url is supplied (503)', async function () {
        const res = await request.get('/relay');
        expect(res.status).to.equal(503);
        expect(res.headers['content-type']).to.include('json');
        expect(res.body.error).to.be.a('string').with.length.above(0);
    });
});
