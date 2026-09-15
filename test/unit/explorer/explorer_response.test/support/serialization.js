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

describe('XChainExplorer.processRequest – JSON serialization', function () {
    it('sends response with Content-Type json for API responses', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._type).to.equal('json');
    });

    it('sends response with Content-Type json for explorer responses', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/explorer/sends/addr1/address', { start: 0, length: 10 });

        expect(res._type).to.equal('json');
    });

    it('serializes BigInt values to strings without throwing', async function () {
        const rows = [{ action_index: BigInt(9007199254740993), amount: '1000' }];
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();

        // Should not throw; jsonStringify handles BigInt
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
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._body).to.be.a('string');
    });
});

describe('XChainExplorer.processRequest – JSON serialization', function () {
    // A DB row (or /relay body) carrying an object merely SHAPED like a serialized
    // mathjs BigNumber but holding a non-numeric value made jsonStringify's replacer
    // throw a DecimalError at the send sink, outside any try/catch -> unhandled
    // rejection -> process crash. It must now serialize the hostile value
    // gracefully rather than throw.
    it('serializes a hostile BigNumber-shaped value without crashing (DoS regression)', async function () {
        const rows = [{ action_index: 1, evil: { mathjs: 'BigNumber', value: 'not-a-number' } }];
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');

        expect(res._status).to.equal(200);
        expect(res._body).to.be.a('string');
        // The malformed value falls back to its string form instead of throwing.
        expect(() => JSON.parse(res._body)).to.not.throw();
        expect(res._body).to.include('not-a-number');
    });

    // The catch-all route handler is fire-and-forget, so processRequest's rejection is
    // routed to sendUnhandled, which must degrade to a 500 instead of crashing.
    it('_sendUnhandled emits a 500 for an unexpected processRequest error', function () {
        const explorer = makeExplorer();
        const res      = mockRes();
        explorer.sendUnhandled(new Error('boom'), { path: '/BTC/api/sends' }, res);
        expect(res._status).to.equal(500);
        expect(res._body).to.be.a('string').and.include('INTERNAL_ERROR');
    });

});

describe('XChainExplorer.processRequest – HTML responses', function () {

    it('loads template and content file for html type requests', async function () {
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/');

        // HTML response: res.send() is called (not res.type('json').send())
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
