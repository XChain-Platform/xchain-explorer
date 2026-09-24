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

const { createConfigInfoStub }   = require('../../../../fixtures/mock-config.js');
const { mockReq, mockRes }       = require('../../../../fixtures/mock-query-args.js');
const mockResults                = require('../../../../fixtures/mock-db-results.js');

// Shared state: control what getData returns per test
const state = { getDataResult: [[], null] };

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults(m) { return 100; }
    async getData(config) { return state.getDataResult; }
}

// Minimal Express stub: returns the same mockApp every time
const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

// Load XChainExplorer with all heavy dependencies replaced
const XChainExplorer = proxyquire('../../../../../src/XChainExplorer.js', {
    'express': express,
    './db/index.js': MockDB,
    'fs': {
        existsSync: () => true,
        readFileSync: () => 'mock'
    }
});

// Stubs fileExists/fileGetContents on the util instance so HTML tests work
// without touching the filesystem.
function makeExplorer(configOverrides) {
    const configInfo = createConfigInfoStub(configOverrides);
    const explorer   = new XChainExplorer(mockApp, configInfo);
    // Stub async FS helpers used by the HTML page handler
    sinon.stub(explorer.util, 'fileExists').resolves(true);
    const fileGetContentsStub = sinon.stub(explorer.util, 'fileGetContents');
    fileGetContentsStub.withArgs(sinon.match(/template\.html/)).resolves('<html>{CONTENT}</html>');
    fileGetContentsStub.resolves('<p>page content</p>');
    return explorer;
}

// Helper: call processRequest and return the populated res mock
async function handle(explorer, path, query = {}) {
    const req = mockReq(path, query);
    const res = mockRes();
    await explorer.processRequest(req, res);
    return res;
}

// Helper: parse the JSON body from the response
function parseBody(res) {
    if (typeof res._body === 'string') {
        return JSON.parse(res._body);
    }
    return res._body;
}

module.exports = { sinon, expect, mockRes, mockResults, state, makeExplorer, handle, parseBody };
