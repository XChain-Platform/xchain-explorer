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

describe('XChainExplorer.processRequest – API response shape', function () {

    it('returns total and data array when getData resolves with numeric total', async function () {
        const rows       = mockResults.sendRows();
        state.getDataResult    = [rows, rows.length];
        const explorer   = makeExplorer();
        const res        = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body       = parseBody(res);

        expect(res._status).to.equal(200);
        expect(body).to.have.property('total', rows.length);
        expect(body).to.have.property('data').that.is.an('array');
    });

    it('sorts top-level JSON keys alphabetically (ksort) – runtime appended after sort', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
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
        state.getDataResult  = [rows, rows.length];
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
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(explorer, '/BTC/api/sends/addr1/address');
        const body     = parseBody(res);

        expect(body).to.have.property('runtime').that.is.a('string');
    });

});

describe('XChainExplorer.processRequest – Explorer response shape', function () {

    it('returns recordsTotal and recordsFiltered for explorer type requests', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
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
        state.getDataResult   = [rows, rows.length];
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

    // An unguarded non-numeric ?total= override flows straight into
    // getPagingDataResults -> bcsub (mathjs), throwing a DecimalError outside any
    // try/catch; on the fire-and-forget catch-all handler that becomes an unhandled
    // rejection that terminates the process (unauthenticated crash-loop DoS). The
    // override must be ignored when non-numeric, keeping the real DB count.
    it('ignores a non-numeric ?total= override instead of crashing (DoS regression)', async function () {
        const rows     = mockResults.sendRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        const res      = await handle(
            explorer,
            '/BTC/explorer/sends/addr1/address',
            { start: 0, length: 10, total: 'abc' }
        );
        const body = parseBody(res);

        expect(res._status).to.equal(200);
        expect(body.recordsTotal).to.equal(rows.length);
        expect(body.recordsTotal).to.be.a('number');
    });

});
