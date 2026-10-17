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

const { expect, makeExplorer, request, state } = require('./explorer_routing.test/support/helpers.js');

describe('XChainExplorer.processRequest – routing', function () {

    before(function () {
        state.explorer = makeExplorer();
    });

    require('./explorer_routing.test/support/parsing.js');
    require('./explorer_routing.test/support/responses.js');
    require('./explorer_routing.test/support/freshness.js');
    require('./explorer_routing.test/support/remaining.js');

    describe('bare list-all api routes', function () {
        for (const [name, method] of [['tokens', 'getTokens'], ['orders', 'getOrders'], ['swaps', 'getSwaps'], ['dispensers', 'getDispensers']]) {
            it('/BTC/api/' + name + ' resolves to ' + method + ' with no search term', async function () {
                const { cfg } = await request(state.explorer, '/BTC/api/' + name);
                expect(cfg).to.not.be.null;
                expect(cfg.type).to.equal('api');
                expect(cfg.data.method).to.equal(method);
                expect(cfg.data.search).to.equal(undefined);
            });

            it('/BTC/api/' + name + '/1/block still resolves to ' + method + ' with its filter', async function () {
                const { cfg } = await request(state.explorer, '/BTC/api/' + name + '/1/block');
                expect(cfg.data.method).to.equal(method);
                expect(cfg.data.search).to.equal('1');
                expect(cfg.data.type).to.equal('block');
            });
        }
    });

    describe('list filter route parity', function () {
        const cases = [
            ['api', 'links', 'XCHAIN', 'token', 'getLinks'],
            ['api', 'order_matches', '1Address', 'address', 'getOrderMatches'],
            ['api', 'order_matches', 'XCHAIN', 'token', 'getOrderMatches'],
            ['explorer', 'order_matches', '1Address', 'address', 'getOrderMatches'],
            ['explorer', 'order_matches', 'XCHAIN', 'token', 'getOrderMatches'],
            ['api', 'swap_matches', '1Address', 'address', 'getSwapMatches'],
            ['api', 'swap_matches', 'XCHAIN', 'token', 'getSwapMatches'],
            ['explorer', 'swap_matches', '1Address', 'address', 'getSwapMatches'],
            ['explorer', 'swap_matches', 'XCHAIN', 'token', 'getSwapMatches'],
            ['api', 'validators', '100', 'block', 'getValidators'],
            ['api', 'validators', '1Address', 'address', 'getValidators']
        ];

        for (const [surface, resource, search, type, method] of cases) {
            it(`/${surface}/${resource}/{QUERY}/${type} resolves to ${method}`, async function () {
                const path = `/BTC/${surface}/${resource}/${search}/${type}`;
                const { cfg } = await request(state.explorer, path);
                expect(cfg, path).to.not.equal(null);
                expect(cfg.type).to.equal(surface);
                expect(cfg.data.method).to.equal(method);
                expect(cfg.data.search).to.equal(search);
                expect(cfg.data.type).to.equal(type);
            });
        }
    });
});
