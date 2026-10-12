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

describe('response codes', function () {
    it('returns 404 for a valid coin + valid route where db returns null data', async function () {
        // MockDB returns [[], null], so data is [] and total is null; when total
        // is null, processRequest falls into the not-found branch (404, so the
        // HTTP status agrees with the NOT_FOUND body code).
        const res = mockRes();
        await explorer.processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
        expect(res._status).to.equal(404);
    });

    // The action route binds its path segment against a BIGINT column, so MariaDB
    // coerces '7junk' to 7 and answers 200 with action 7. The 400 must also survive
    // the empty-result branch further down, which would otherwise rewrite it to 404.
    ['7junk', 'junk', '7.5', '-1', '0x7', '7%20', '9007199254740992'].forEach((bad) => {
        it(`400s /BTC/api/action/${bad} instead of coercing it to a real action`, async function () {
            const { cfg, res } = await request(explorer, '/BTC/api/action/' + bad);
            expect(res._status).to.equal(400);
            // processRequest serializes the api body itself, so _body is a JSON string.
            expect(JSON.parse(res._body).code).to.equal('INVALID_ACTION_INDEX');
            expect(cfg, 'the DB was never queried').to.be.null;
        });
    });

    it('still routes a well-formed /BTC/api/action/7 through to the DB', async function () {
        const { cfg, res } = await request(explorer, '/BTC/api/action/7');
        expect(cfg, 'the DB was queried').to.not.be.null;
        expect(cfg.data.method).to.equal('getAction');
        expect(cfg.data.search).to.equal('7');
        expect(res._status).to.not.equal(400);
    });

    // The sibling block route is declined too, but a layer down: the
    // refusal is a DbInputError raised by db/index.js getBlock, not a route-table
    // guard, so it covers every caller of the reader rather than one URL. This
    // MockDB stands in for db/index.js and therefore never raises it, which is exactly
    // what makes this a useful assertion about the ROUTE table: no route-layer
    // guard intercepts /api/block, so the request still reaches the reader.
    // The 400 itself is pinned in block-query-guard.test.js, which drives the
    // real getBlock.
    it('routes /BTC/api/block/{n} to the reader rather than intercepting it in the route table', async function () {
        const { cfg } = await request(explorer, '/BTC/api/block/9junk');
        expect(cfg, 'block route reaches the reader, which is where it is refused').to.not.be.null;
        expect(cfg.data.method).to.equal('getBlock');
    });

    it('returns 503 for a supported-but-unavailable coin (LTC not in COIN_AVAILABLE)', async function () {
        // LTC is in COIN_SUPPORTED but not in COIN_AVAILABLE (per mock-config).
        const res = mockRes();
        await explorer.processRequest(mockReq('/LTC/api/sends/addr1/address'), res);
        expect(res._status).to.equal(503);
    });
});

describe('response codes', function () {
    it('/BTC/api/status returns 404 when coin is available but db returns null (no record)', async function () {
        // validDataRequest is forced true for status, db returns null → not-found 404
        const res = mockRes();
        await explorer.processRequest(mockReq('/BTC/api/status'), res);
        // getStatus has no total so data=[] total=null → 404
        expect(res._status).to.equal(404);
    });

    it('returns 404 with html type for an unknown URL', async function () {
        const res = mockRes();
        await explorer.processRequest(mockReq('/BTC/api/unknownendpoint/x/y'), res);
        expect(res._status).to.equal(404);
    });

    it('returns 503 for explorer type on unavailable coin', async function () {
        const res = mockRes();
        await explorer.processRequest(mockReq('/LTC/explorer/sends/addr1/address'), res);
        expect(res._status).to.equal(503);
    });

});
