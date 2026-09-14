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
 * Unit tests for URL matching and cfg construction in XChainExplorer.processRequest()
 *
 * Strategy: proxyquire replaces express and db/index.js so the class can be instantiated
 * without a real database or HTTP server.  A MockDB captures the cfg object passed
 * to getData(), letting each test inspect what processRequest() built from the URL.
 */

const { expect }            = require('chai');
const proxyquire            = require('proxyquire').noCallThru();
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { mockReq, mockRes }  = require('../../../fixtures/mock-query-args.js');

/** Captured cfg from the most-recent getData() call */
let capturedConfig = null;

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(config) {
        capturedConfig = config;
        // getBalances sets `json.address = cfg.data.search` AFTER merging data into json
        // (json = data when total is null).  If data is null that assignment throws, so
        // return an empty object for that method to give json a non-null target.
        if (config.data.method === 'getBalances') {
            return [{}, null];
        }
        // For all other methods return [null, null] so data and total are both null,
        // keeping the 400 response-code branch reachable in assertions.
        return [null, null];
    }
}

/** Minimal express mock – the constructor returns an object that satisfies the
 *  calls inside XChainExplorer (app.use / app.get / app.enable).  Static helpers
 *  are no-ops so proxyquire.noCallThru() never reaches the real express module. */
const mockApp = {
    use: () => {},
    get: () => {},
    post: () => {},
    enable: () => {}
};
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

/** Load the class under test with its two heavy deps replaced */
const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
    'express':  expressMock,
    './db/index.js':  MockDB
});

// Build an explorer instance, with config overrides for the tests that need them.
function makeExplorer(configOverrides) {
    const configInfo = createConfigInfoStub(configOverrides);
    return new XChainExplorer(mockApp, configInfo);
}

/** Drive processRequest and return { cfg, res } */
async function request(explorer, path, query = {}) {
    capturedConfig = null;
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query), res);
    return { cfg: capturedConfig, res };
}

const state = { explorer: null };

module.exports = { expect, mockReq, mockRes, makeExplorer, request, state };
