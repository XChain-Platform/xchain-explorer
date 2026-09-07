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
 * Unit tests for the /{COIN}/api/checkpoint/{QUERY} malformed-id guard in
 * XChainExplorer.processRequest() (D-E060).
 *
 * db.js's getCheckpoint binds config.data.search as Number(config.data.search):
 * a non-numeric segment becomes NaN, which the mariadb driver cannot bind and
 * throws, so a request like /api/checkpoint/zzz-no-such reached the generic
 * catch in processRequest and answered 500 DB_ERROR instead of a clean 4xx -
 * failing G3 ("not a 500, not an HTML shell") for a malformed input. Mirrors
 * the harness and the /api/action/{QUERY} precedent in explorer.routing.test.js.
 */

const { expect }            = require('chai');
const proxyquire            = require('proxyquire').noCallThru();
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }  = require('../fixtures/mock-query-args.js');

/** Captured cfg from the most-recent getData() call */
let capturedConfig = null;

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(config) {
        capturedConfig = config;
        // Both data and total null keeps the not-found (404) branch reachable,
        // matching what getCheckpoint returns for a well-formed but absent height
        // ([null] wrapped, so data ends up null after processRequest unwraps it).
        return [null, null];
    }
}

const mockApp = {
    use: () => {},
    get: () => {},
    post: () => {},
    enable: () => {}
};
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express':  expressMock,
    './db.js':  MockDB
});

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

describe('XChainExplorer.processRequest – /api/checkpoint/{QUERY} guard', function () {

    let explorer;

    before(function () {
        explorer = makeExplorer();
    });

    ['zzz-no-such', 'junk', '7.5', '-1', '1e5', '0x7', '7 '].forEach((bad) => {
        it(`400s /BTC/api/checkpoint/${bad} instead of reaching the DB (was 500 DB_ERROR)`, async function () {
            const { cfg, res } = await request(explorer, '/BTC/api/checkpoint/' + bad);
            expect(res._status).to.equal(400);
            // processRequest serializes the api body itself, so _body is a JSON string.
            expect(JSON.parse(res._body).code).to.equal('INVALID_BLOCK_INDEX');
            expect(cfg, 'the DB was never queried').to.be.null;
        });
    });

    it('still routes a well-formed /BTC/api/checkpoint/1200 through to the DB', async function () {
        const { cfg, res } = await request(explorer, '/BTC/api/checkpoint/1200');
        expect(cfg, 'the DB was queried').to.not.be.null;
        expect(cfg.data.method).to.equal('getCheckpoint');
        expect(cfg.data.search).to.equal('1200');
        expect(res._status).to.not.equal(400);
    });

    it('answers a clean 404 for a well-formed but absent height (MockDB returns no row)', async function () {
        const { res } = await request(explorer, '/BTC/api/checkpoint/1200');
        expect(res._status).to.equal(404);
        expect(JSON.parse(res._body).code).to.equal('NOT_FOUND');
    });

});
