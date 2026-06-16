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
 * Unit tests for processRequest response formatting in src/XChainExplorer.js
 *
 * Covers:
 *   - API response shape (total, data, ksort, runtime)
 *   - Explorer response shape (recordsTotal, recordsFiltered, query.total override)
 *   - Special method top-level fields (getBalances, getHolders, getSearch)
 *   - Error responses (503 unsupported coin, 400 null data, 404 no match)
 *   - Headers (XChain-Explorer-Version, Access-Control-Allow-Origin, XChain-Runtime-Ms)
 *   - JSON serialization (jsonStringify, Content-Type)
 *   - HTML responses (template + content file, {CONTENT} replacement)
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const { createConfigInfoStub }   = require('../fixtures/mock-config.js');
const { mockReq, mockRes }       = require('../fixtures/mock-query-args.js');
const mockResults                = require('../fixtures/mock-db-results.js');

// ---------------------------------------------------------------------------
// Shared state: control what getData returns per test
// ---------------------------------------------------------------------------

let getDataResult = [[], null];

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults(m) { return 100; }
    async getData(config) { return getDataResult; }
}

// ---------------------------------------------------------------------------
// Minimal Express stub — returns the same mockApp every time
// ---------------------------------------------------------------------------

const mockApp = { use: () => {}, get: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

// ---------------------------------------------------------------------------
// Load XChainExplorer with all heavy dependencies replaced
// ---------------------------------------------------------------------------

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB,
    'fs': {
        existsSync: () => true,
        readFileSync: () => 'mock'
    }
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a configured XChainExplorer instance.
 * Stubs fileExists/fileGetContents on the util instance so HTML tests work
 * without touching the filesystem.
 */
function makeExplorer(configOverrides) {
    const configInfo = createConfigInfoStub(configOverrides);
    const explorer   = new XChainExplorer(mockApp, configInfo);
    // Stub async FS helpers used by the HTML page handler
    sinon.stub(explorer.util, 'fileExists').resolves(true);
    sinon.stub(explorer.util, 'fileGetContents')
        .withArgs(sinon.match(/template\.html/)).resolves('<html>{CONTENT}</html>')
        .resolves('<p>page content</p>');
    return explorer;
}

// Restore all sinon stubs/spies created during a test
afterEach(function () {
    sinon.restore();
    // Reset default getData result
    getDataResult = [[], null];
});

// ---------------------------------------------------------------------------
// Helper: call processRequest and return the populated res mock
// ---------------------------------------------------------------------------

async function handle(explorer, path, query = {}) {
    const req = mockReq(path, query);
    const res = mockRes();
    await explorer.processRequest(req, res);
    return res;
}

// ---------------------------------------------------------------------------
// Helper: parse the JSON body from the response
// ---------------------------------------------------------------------------

function parseBody(res) {
    if (typeof res._body === 'string') {
        return JSON.parse(res._body);
    }
    return res._body;
}

// ===========================================================================
// 1. API response shape
// ===========================================================================

describe('XChainExplorer.processRequest – API response shape', function () {

    it('returns total and data array when getData resolves with numeric total', async function () {
        const rows       = mockResults.sendRows();
        getDataResult    = [rows, rows.length];
        const explorer   = makeExplorer();
        const res        = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body       = parseBody(res);

        expect(res._status).to.equal(200);
        expect(body).to.have.property('total', rows.length);
        expect(body).to.have.property('data').that.is.an('array');
    });

    it('sorts top-level JSON keys alphabetically (ksort) – runtime appended after sort', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        const keys = Object.keys(body);

        // The ksort runs before `runtime` is appended, so all keys EXCEPT the
        // trailing `runtime` are in alphabetical order.
        const withoutRuntime = keys.filter(k => k !== 'runtime');
        const sortedWithout  = [...withoutRuntime].sort();
        expect(withoutRuntime).to.deep.equal(sortedWithout);

        // `runtime` is always the last key
        expect(keys[keys.length - 1]).to.equal('runtime');
    });

    it('sorts keys of each data item alphabetically (ksort on items)', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(body.data).to.have.length.greaterThan(0);
        for (const item of body.data) {
            const keys       = Object.keys(item);
            const sortedKeys = [...keys].sort();
            expect(keys).to.deep.equal(sortedKeys);
        }
    });

    it('always includes a runtime field in the JSON response', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(body).to.have.property('runtime').that.is.a('string');
    });

});

// ===========================================================================
// 2. Explorer response shape
// ===========================================================================

describe('XChainExplorer.processRequest – Explorer response shape', function () {

    it('returns recordsTotal and recordsFiltered for explorer type requests', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/explorer/sends/addr1/address', { start: 0, length: 10 });
        const body     = parseBody(res);

        expect(res._status).to.equal(200);
        expect(body).to.have.property('recordsTotal');
        expect(body).to.have.property('recordsFiltered');
        expect(body).to.have.property('data').that.is.an('array');
    });

    it('uses query.total as the total when provided in the request', async function () {
        const rows      = mockResults.sendRows();
        getDataResult   = [rows, rows.length];
        const overrideTotal = 9999;
        const explorer  = makeExplorer();
        const res       = await handle(
            explorer,
            '/BTC/explorer/sends/addr1/address',
            { start: 0, length: 10, total: overrideTotal }
        );
        const body = parseBody(res);

        expect(body.recordsTotal).to.equal(overrideTotal);
        expect(body.recordsFiltered).to.equal(overrideTotal);
    });

});

// ===========================================================================
// 3. Special method top-level fields
// ===========================================================================

describe('XChainExplorer.processRequest – special method responses', function () {

    it('getBalances: adds address field to top-level JSON', async function () {
        const rows     = mockResults.balanceRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        // /BTC/api/balances/{address}
        const res      = await handle(explorer, '/BTC/api/balances/addr1');
        const body     = parseBody(res);

        expect(body).to.have.property('address', 'addr1');
    });

    it('getHolders: adds tick, supply, decimals, coin_price to top-level JSON', async function () {
        const rows     = mockResults.holderRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/holders/XCHAIN');
        const body     = parseBody(res);

        expect(body).to.have.property('tick',       rows[0].tick);
        expect(body).to.have.property('supply',     rows[0].supply);
        expect(body).to.have.property('decimals',   rows[0].decimals);
        expect(body).to.have.property('coin_price', rows[0].coin_price);
    });

    it('getHolders: data items contain only address and amount', async function () {
        const rows     = mockResults.holderRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/holders/XCHAIN');
        const body     = parseBody(res);

        expect(body.data).to.have.length.greaterThan(0);
        for (const item of body.data) {
            expect(item).to.have.property('address');
            expect(item).to.have.property('amount');
            expect(item).to.not.have.property('tick');
        }
    });

    it('getSearch: merges search-specific fields into top-level JSON', async function () {
        // getSearch returns data as an object with search result sub-arrays
        const searchData = {
            data: mockResults.searchAddressRows(),
            type: 'address',
            query: 'addr1'
        };
        // No numeric total means json = data (not wrapped)
        getDataResult   = [searchData, null];
        const explorer  = makeExplorer();
        const res       = await handle(explorer, '/BTC/explorer/search/addr1/address', { start: 0, length: 10 });
        const body      = parseBody(res);

        // The merged object should include extra fields from searchData
        expect(body).to.have.property('type');
        expect(body).to.have.property('query');
        // data key should have been deleted (getSearch special case: delete data.data)
        expect(body).to.not.have.property('data');
    });

});

// ===========================================================================
// 4. Error responses
// ===========================================================================

describe('XChainExplorer.processRequest – error responses', function () {

    it('returns HTTP 503 when coin is supported but not available', async function () {
        // LTC is in COIN_SUPPORTED but not in COIN_AVAILABLE (per mock-config fixture).
        // validDataRequest=false so getData is never called — 503 is returned.
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/LTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(res._status).to.equal(503);
        expect(body).to.have.property('error').that.includes('not configured');
    });

    it('returns HTTP 400 when getData returns null data and null total', async function () {
        getDataResult  = [null, null];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(res._status).to.equal(400);
        expect(body).to.have.property('error').that.is.a('string');
    });

    it('returns HTTP 404 when no file and no method match the path', async function () {
        const explorer = makeExplorer();
        // Path that won't match any html, api, or explorer route
        const res      = await handle(explorer, '/totally/unknown/route/that/does/not/exist');
        // 404 is an html response (type switches to html and sets 404.html)
        expect(res._status).to.equal(404);
    });

});

// ===========================================================================
// 5. Response headers
// ===========================================================================

describe('XChainExplorer.processRequest – response headers', function () {

    it('does NOT set XChain-Explorer-Version header (info leakage prevention)', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._headers).to.not.have.property('XChain-Explorer-Version');
    });

    it('does NOT set Access-Control-Allow-Origin in custom headers (handled by cors middleware)', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        // Custom headers object should not contain this — cors middleware handles it
        expect(res._headers).to.not.have.property('Access-Control-Allow-Origin');
    });

    it('does NOT set XChain-Runtime-Ms header when DEBUG is not set', async function () {
        const origDebug = process.env.DEBUG;
        delete process.env.DEBUG;
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._headers).to.not.have.property('XChain-Runtime-Ms');
        if(origDebug) process.env.DEBUG = origDebug;
    });

});

// ===========================================================================
// 6. JSON serialization
// ===========================================================================

describe('XChainExplorer.processRequest – JSON serialization', function () {

    it('sends response with Content-Type json for API responses', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._type).to.equal('json');
    });

    it('sends response with Content-Type json for explorer responses', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/explorer/sends/addr1/address', { start: 0, length: 10 });

        expect(res._type).to.equal('json');
    });

    it('serializes BigInt values to strings without throwing', async function () {
        const rows = [{ action_index: BigInt(9007199254740993), amount: '1000' }];
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();

        // Should not throw — jsonStringify handles BigInt
        let res;
        expect(async () => {
            res = await handle(explorer, '/BTC/api/sends/addr1/address');
        }).to.not.throw();

        res = await handle(explorer, '/BTC/api/sends/addr1/address');
        expect(res._status).to.equal(200);
        // The body should be a valid JSON string (BigInt serialised as string)
        expect(() => JSON.parse(res._body)).to.not.throw();
    });

    it('sends the body as a string (jsonStringify output)', async function () {
        const rows     = mockResults.sendRows();
        getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._body).to.be.a('string');
    });

});

// ===========================================================================
// 7. HTML responses
// ===========================================================================

describe('XChainExplorer.processRequest – HTML responses', function () {

    it('loads template and content file for html type requests', async function () {
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/');

        // HTML response — res.send() is called (not res.type('json').send())
        expect(res._type).to.not.equal('json');
        expect(res._body).to.be.a('string');
    });

    it('replaces {CONTENT} placeholder in template with page content', async function () {
        const explorer = makeExplorer();
        // Ensure the stub gives us distinguishable template vs content strings
        explorer.util.fileGetContents.restore();
        sinon.stub(explorer.util, 'fileGetContents')
            .withArgs(sinon.match(/template\.html/)).resolves('<html>{CONTENT}</html>')
            .resolves('<p>page content</p>');

        const res = await handle(explorer, '/');

        // {CONTENT} in the template should have been replaced by page content
        expect(res._body).to.include('<p>page content</p>');
        expect(res._body).to.not.include('{CONTENT}');
    });

    it('returns HTTP 200 for a known HTML route', async function () {
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/about');

        expect(res._status).to.equal(200);
    });

    it('returns a 404 HTML page (not JSON) for an unmatched route', async function () {
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/no/such/page/anywhere');

        expect(res._status).to.equal(404);
        // Should be an HTML send, not a JSON send
        expect(res._type).to.not.equal('json');
    });

});
