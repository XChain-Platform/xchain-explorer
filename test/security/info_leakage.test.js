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
const { createConfigInfoStub, getFullConfig } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../fixtures/mock-query-args.js');
const { getLogger }            = require('../../src/observability');
const { createLogShipper }     = require('../../src/observability/logShipper.js');

// What the fake database hands back; each test sets it to shape the response it checks for leaks
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
    './db/index.js': MockDB,
    'fs': {
        existsSync: () => true,
        readFileSync: () => 'mock'
    }
});

function makeExplorer(configInfo = createConfigInfoStub()) {
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

describe('Security: Info Leakage: Debug logging', function () {

    // Stubbed on the lazy logger object XChainExplorer.js holds, so the dump is seen
    // whether or not an earlier suite installed the real shipper.
    let infoStub;

    beforeEach(() => {
        infoStub = sinon.stub(getLogger(), 'info');
    });

    afterEach(() => {
        infoStub.restore();
        delete process.env.DEBUG;
    });

    function requestConfigDumps() {
        return infoStub.getCalls().filter(c => c.args[0] === 'REQUEST_CONFIG');
    }

    it('does NOT log request config when DEBUG is not set', async function () {
        delete process.env.DEBUG;
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(requestConfigDumps()).to.have.length(0);
    });

    it('logs request config when DEBUG is set', async function () {
        process.env.DEBUG = '1';
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        await handle(explorer, '/BTC/api/sends/addr1/address');

        const dumps = requestConfigDumps();
        expect(dumps).to.have.length(1);
        expect(dumps[0].args[1].data.path).to.equal('/BTC/api/sends/addr1/address');
    });

    it('the request config dump carries no credential, from the config or the query', async function () {
        process.env.DEBUG = '1';
        getDataResult = [[{ action_index: 1 }], 1];

        // Plant one sentinel in every credential slot of the config the explorer
        // holds: a dump widened from the request config to the service config
        // would carry it.
        const CONFIG_SECRET = 'cfg-secret-7f3a9c';
        const config = getFullConfig();
        (function plant(node) {
            if (!node || typeof node !== 'object') return;
            for (const key of Object.keys(node)) {
                if (/^(pass|password|token|api_key)$/i.test(key)) node[key] = CONFIG_SECRET;
                else plant(node[key]);
            }
        })(config);
        const explorer = makeExplorer(createConfigInfoStub(config));

        const QUERY_SECRET = 'query-secret-51d2e8';
        await handle(explorer, '/BTC/api/sends/addr1/address', { api_key: QUERY_SECRET, limit: '5' });

        const dumps = requestConfigDumps();
        expect(dumps).to.have.length(1);
        const fields = dumps[0].args[1];
        expect(JSON.stringify(fields)).to.not.include(CONFIG_SECRET);

        // What reaches a sink is the shipper's record, which redacts secret-named
        // keys in the client-supplied query while keeping the rest of it.
        const lines = [];
        const sink  = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
        createLogShipper({ service: 'xchain-explorer', env: { LOG_FORMAT: 'json' }, console: sink })
            .info(dumps[0].args[0], fields);
        expect(lines).to.have.length(1);
        expect(lines[0]).to.not.include(QUERY_SECRET);
        expect(lines[0]).to.not.include(CONFIG_SECRET);
        expect(JSON.parse(lines[0]).data.query.limit).to.equal('5');
    });
});

describe('Security: Info Leakage: Error responses', function () {

    it('returns generic error for failed data requests (no stack trace)', async function () {
        getDataResult = [null, null];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');

        // A failed/empty data request returns a client-error status (400 or a
        // 404 not-found); the security property under test is that the body is
        // generic and leaks no stack trace / driver internals, asserted below.
        expect(res._status).to.be.oneOf([400, 404]);
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

describe('Security: Info Leakage: JSON response runtime', function () {

    it('includes runtime string in JSON responses (public info)', async function () {
        getDataResult = [[{ action_index: 1 }], 1];
        const explorer = makeExplorer();
        const res = await handle(explorer, '/BTC/api/sends/addr1/address');

        const body = JSON.parse(res._body);
        expect(body).to.have.property('runtime').that.is.a('string');
    });
});
