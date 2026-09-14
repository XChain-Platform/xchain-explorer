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

const {
    sinon, expect, mockRes, mockResults, state, makeExplorer, handle, parseBody
} = require('./helpers.js');

describe('XChainExplorer.processRequest – error responses', function () {
    it('returns HTTP 503 when coin is supported but not available', async function () {
        // LTC is in COIN_SUPPORTED but not in COIN_AVAILABLE (per mock-config fixture).
        // validDataRequest=false so getData is never called; 503 is returned.
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/LTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(res._status).to.equal(503);
        expect(body).to.have.property('error').that.includes('not configured');
    });

    it('returns HTTP 404 when getData returns null data and null total', async function () {
        state.getDataResult  = [null, null];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(res._status).to.equal(404);
        expect(body).to.have.property('error').that.is.a('string');
    });

    it('returns HTTP 404 when no file and no method match the path', async function () {
        const explorer = makeExplorer();
        // Path that won't match any html, api, or explorer route
        const res      = await handle(explorer, '/totally/unknown/route/that/does/not/exist');
        // 404 is an html response (type switches to html and sets 404.html)
        expect(res._status).to.equal(404);
    });

    // M-4: a genuine DB failure must surface as a 5xx, not a misleading empty
    // 200 (or a NOT_FOUND 404). db/index.js's doQuery now throws a DbQueryError on a
    // failed read; getData propagates it and processRequest maps it to 500.
    it('returns HTTP 500 DB_ERROR when getData throws (DB outage != empty result)', async function () {
        const explorer = makeExplorer();
        const err      = new Error('SQL query failed: Connection lost');
        err.name       = 'DbQueryError';
        err.code       = 'DB_ERROR';
        sinon.stub(explorer.db, 'getData').rejects(err);

        const res  = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body = parseBody(res);

        expect(res._status).to.equal(500);
        expect(body).to.have.property('code', 'DB_ERROR');
        // Must NOT be downgraded to a NOT_FOUND 404 by the empty-result fallback.
        expect(body).to.not.have.property('total');
    });
});

describe('XChainExplorer.processRequest – error responses', function () {
    it('a genuinely empty result still returns HTTP 200 with total 0 (not a 5xx)', async function () {
        // The M-4 fix must not turn empty SELECTs into errors: only FAILED reads
        // throw. getData resolving [[], 0] is a successful empty page.
        state.getDataResult  = [[], 0];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(res._status).to.equal(200);
        expect(body).to.have.property('total', 0);
    });

});

describe('XChainExplorer.processRequest – response headers', function () {

    it('does NOT set XChain-Explorer-Version header (info leakage prevention)', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._headers).to.not.have.property('XChain-Explorer-Version');
    });

    it('does NOT set Access-Control-Allow-Origin in custom headers (handled by cors middleware)', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        // Custom headers object should not contain this (cors middleware handles it)
        expect(res._headers).to.not.have.property('Access-Control-Allow-Origin');
    });

    it('does NOT set XChain-Runtime-Ms header when DEBUG is not set', async function () {
        const origDebug = process.env.DEBUG;
        delete process.env.DEBUG;
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._headers).to.not.have.property('XChain-Runtime-Ms');
        if(origDebug) process.env.DEBUG = origDebug;
    });

});
