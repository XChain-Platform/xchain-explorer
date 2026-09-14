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

const { expect, mockReq, mockRes, makeExplorer, request, state } = require('./helpers.js');

let explorer;
before(function () { explorer = state.explorer; });

describe('null string handling', function () {

    it('/BTC/api/history/null/block converts "null" search to null', async function () {
        const { cfg } = await request(explorer, '/BTC/api/history/null/block');
        expect(cfg).to.not.be.null;
        expect(cfg.data.search).to.be.null;
    });

});

describe('explorer offset params', function () {

    it('populates cfg.data.offset from query params ?offset=100&action=next', async function () {
        const { cfg } = await request(
            explorer,
            '/BTC/explorer/sends/addr1/address',
            { offset: '100', action: 'next' }
        );
        expect(cfg).to.not.be.null;
        expect(cfg.data.offset.start).to.equal('100');
        expect(cfg.data.offset.action).to.equal('next');
    });

    it('leaves offset as false (no-value sentinel) when no query params are provided', async function () {
        // processRequest uses `false` (not null) when offset/action are absent:
        //   let offset = (q && !isNull(q.offset)) ? q.offset : false;
        const { cfg } = await request(explorer, '/BTC/explorer/sends/addr1/address');
        expect(cfg).to.not.be.null;
        expect(cfg.data.offset.start).to.equal(false);
        expect(cfg.data.offset.action).to.equal(false);
    });

});

// Page routes: each path must be assigned its HTML file rather than fall
// through to a routing error.
describe('HTML routes', function () {

    /** For HTML routes, getData is never called so capturedConfig stays null.
     *  We inspect the response status and confirm it is not a routing error. */

    it('/ → home.html served (not 404)', async function () {
        const res = mockRes();
        await explorer.processRequest(mockReq('/'), res);
        expect(res._status).to.not.equal(404);
    });

    it('/BTC → coin_home.html served (not 404)', async function () {
        const res = mockRes();
        await explorer.processRequest(mockReq('/BTC'), res);
        expect(res._status).to.not.equal(404);
    });

    it('/BTC/tokens → tokens.html served (not 404)', async function () {
        const res = mockRes();
        await explorer.processRequest(mockReq('/BTC/tokens'), res);
        expect(res._status).to.not.equal(404);
    });

});
