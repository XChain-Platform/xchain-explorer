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
 * Security tests: Information Leakage Prevention
 *
 * Verifies that debug logging is gated, version headers removed,
 * runtime headers gated, and error responses don't contain internal details.
 *
 * Run: mocha test/security/info-leakage.test.js --timeout 0
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Shared state for getData mock
// ---------------------------------------------------------------------------

let getDataResult = [[], null];

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData() { return getDataResult; }
}

const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const mockExpress  = () => mockApp;
mockExpress.static = () => {};
mockExpress.json   = () => {};

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': mockExpress,
    './db.js': MockDB,
    'fs': {
        existsSync: () => true,
        readFileSync: () => 'mock'
    }
});

function makeExplorer() {
    const configInfo = createConfigInfoStub();
    const explorer   = new XChainExplorer(mockApp, configInfo);
    sinon.stub(explorer.util, 'fileExists').resolves(true);
    sinon.stub(explorer.util, 'fileGetContents')
        .withArgs(sinon.match(/template\.html/)).resolves('<html>{CONTENT}</html>')
        .resolves('<p>page</p>');
    return explorer;
}

afterEach(() => {
    sinon.restore();
    getDataResult = [[], null];
});

async function handle(explorer, urlPath, query = {}) {
    const req = mockReq(urlPath, query);
    const res = mockRes();
    await explorer.processRequest(req, res);
    return res;
}

// ===========================================================================
// Custom header removal
// ===========================================================================

describe('Security: Info Leakage: Custom headers', function () {

    it('does not include XChain-Explorer-Version header', async function () {
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');
        expect(res._headers).to.not.have.property('XChain-Explorer-Version');
    });

    it('does not include Access-Control-Allow-Origin in custom headers', async function () {
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');
        expect(res._headers).to.not.have.property('Access-Control-Allow-Origin');
    });

    it('default headers object is empty', function () {
        const explorer = makeExplorer();
        expect(explorer.headers).to.deep.equal({});
    });
});

// ===========================================================================
// Runtime header gating
// ===========================================================================

describe('Security: Info Leakage: Runtime header', function () {

    afterEach(() => { delete process.env.DEBUG; });

    it('does NOT include XChain-Runtime-Ms when DEBUG is not set', async function () {
        delete process.env.DEBUG;
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');
        expect(res._headers).to.not.have.property('XChain-Runtime-Ms');
    });

    it('includes XChain-Runtime-Ms when DEBUG is set', async function () {
        process.env.DEBUG = '1';
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');
        expect(res._headers).to.have.property('XChain-Runtime-Ms').that.is.a('number');
    });
});

// ===========================================================================
// Debug logging gating
// ===========================================================================

describe('Security: Info Leakage: Debug logging', function () {

    let consoleLogStub, consoleDirStub;

    beforeEach(() => {
        consoleLogStub = sinon.stub(console, 'log');
        consoleDirStub = sinon.stub(console, 'dir');
    });

    afterEach(() => {
        consoleLogStub.restore();
        consoleDirStub.restore();
        delete process.env.DEBUG;
    });

    it('does NOT log request config when DEBUG is not set', async function () {
        delete process.env.DEBUG;
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        await handle(explorer, '/BTC/api/sends/addr1/address');

        const logCalls = consoleLogStub.getCalls().map(c => c.args[0]);
        expect(logCalls).to.not.include('--- REQUEST CONFIG ---');
        expect(consoleDirStub.called).to.be.false;
    });

    it('logs request config when DEBUG is set', async function () {
        process.env.DEBUG = '1';
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        await handle(explorer, '/BTC/api/sends/addr1/address');

        const logCalls = consoleLogStub.getCalls().map(c => c.args[0]);
        expect(logCalls).to.include('--- REQUEST CONFIG ---');
        expect(consoleDirStub.called).to.be.true;
    });
});

// ===========================================================================
// Error response safety
// ===========================================================================

describe('Security: Info Leakage: Error responses', function () {

    it('returns generic error for failed data requests (no stack trace)', async function () {
        getDataResult = [null, null];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._status).to.equal(400);
        const body = JSON.parse(res._body);
        expect(body).to.have.property('error');
        expect(body.error).to.not.include('stack');
        expect(body.error).to.not.include('Error:');
        expect(body.error).to.not.include('database');
    });

    it('returns 503 for unsupported coin without leaking credentials', async function () {
        getDataResult = [null, null];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/LTC/api/sends/addr1/address');

        expect(res._status).to.equal(503);
        const body = JSON.parse(res._body);
        expect(body.error).to.not.include('host');
        expect(body.error).to.not.include('password');
    });
});

// ===========================================================================
// Runtime info in JSON response
// ===========================================================================

describe('Security: Info Leakage: JSON response runtime', function () {

    it('includes runtime string in JSON responses (public info)', async function () {
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');

        const body = JSON.parse(res._body);
        expect(body).to.have.property('runtime').that.is.a('string');
    });
});
