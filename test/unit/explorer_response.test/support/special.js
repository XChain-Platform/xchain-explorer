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

describe('XChainExplorer.processRequest – special method responses', function () {
    it('getBalances: adds address field to top-level JSON', async function () {
        const rows     = mockResults.balanceRows();
        state.getDataResult  = [rows, rows.length];
        const explorer = makeExplorer();
        // /BTC/api/balances/{address}
        const res      = await handle(explorer, '/BTC/api/balances/addr1');
        const body     = parseBody(res);

        expect(body).to.have.property('address', 'addr1');
    });

    it('getHolders: adds tick, supply, decimals, coin_price to top-level JSON', async function () {
        const rows     = mockResults.holderRows();
        state.getDataResult  = [rows, rows.length];
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
        state.getDataResult  = [rows, rows.length];
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
});

describe('XChainExplorer.processRequest – special method responses', function () {
    it('getSearch: merges search-specific fields into top-level JSON', async function () {
        // getSearch returns data as an object with search result sub-arrays
        const searchData = {
            data: mockResults.searchAddressRows(),
            type: 'address',
            query: 'addr1'
        };
        // No numeric total means json = data (not wrapped)
        state.getDataResult   = [searchData, null];
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

// The client extracts action_index = data[len-1] and status = data[len-2], paging
// on data[len-1]. getDispensers/getOrders/getSwaps append give/get_ownership AFTER
// action_index, which put an ownership flag (0/1) where the cursor should be.
// These pin the invariant: ownership flags sit BEFORE status/action_index.

describe('XChainExplorer.processRequest – ownership row shape (action_index last)', function () {

    // The datatables (/explorer/) path shapes rows into positional arrays; the
    // /api/ path returns objects. The client consumes the array form.
    const dtQuery = { start: 0, length: 10 };

    it('getDispensers: give_ownership sits before status/action_index', async function () {
        state.getDataResult  = [[{ ...mockResults.dispenserRows()[0], give_ownership: 1 }], 1];
        const explorer = makeExplorer();
        const row      = parseBody(await handle(explorer, '/BTC/explorer/dispensers/addr1/address', dtQuery)).data[0];
        expect(row[row.length - 1]).to.equal(70, 'action_index is the last element (paging cursor)');
        expect(row[row.length - 3]).to.equal(1,  'give_ownership sits immediately before status/action_index');
    });

    it('getOrders: give/get_ownership sit before status/action_index', async function () {
        state.getDataResult  = [[{ ...mockResults.orderRows()[0], give_ownership: 1, get_ownership: 1 }], 1];
        const explorer = makeExplorer();
        const row      = parseBody(await handle(explorer, '/BTC/explorer/orders/addr1/address', dtQuery)).data[0];
        expect(row[row.length - 1]).to.equal(60, 'action_index is the last element');
        expect(row[row.length - 4]).to.equal(1,  'give_ownership before status/action_index');
        expect(row[row.length - 3]).to.equal(1,  'get_ownership before status/action_index');
    });

    it('getSwaps: give/get_ownership sit before status/action_index', async function () {
        state.getDataResult  = [[{ ...mockResults.orderRows()[0], give_ownership: 1, get_ownership: 1 }], 1];
        const explorer = makeExplorer();
        const row      = parseBody(await handle(explorer, '/BTC/explorer/swaps/addr1/address', dtQuery)).data[0];
        expect(row[row.length - 1]).to.equal(60, 'action_index is the last element');
        expect(row[row.length - 4]).to.equal(1,  'give_ownership before status/action_index');
        expect(row[row.length - 3]).to.equal(1,  'get_ownership before status/action_index');
    });

});
