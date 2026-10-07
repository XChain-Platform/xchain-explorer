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
 * The bare list-all API requests answer without a search term while their
 * filtered route declarations remain the canonical dispatch entries.
 */

const { expect } = require('chai');
const { api } = require('../../../../src/explorer/routes/api_methods.js');
const SPEC = require('../../../../src/content/json/xchain-platform-api.json');

const LIST_ALL = {
    '/{COIN}/api/tokens'     : 'getTokens',
    '/{COIN}/api/orders'     : 'getOrders',
    '/{COIN}/api/swaps'      : 'getSwaps',
    '/{COIN}/api/dispensers' : 'getDispensers'
};

describe('bare list-all API routes', function () {

    for (const [route, method] of Object.entries(LIST_ALL)) {
        it(route + ' reuses the filtered ' + method + ' route declaration', function () {
            expect(api[route]).to.equal(undefined);
            expect(api[route + '/{QUERY}/{TYPE}'][0]).to.equal(method);
        });

        it(route + ' is declared in the OpenAPI document without TYPE or QUERY', function () {
            const op = SPEC.paths[route] && SPEC.paths[route].get;
            expect(op, 'spec entry').to.be.an('object');
            const refs = op.parameters.map(p => p.$ref);
            expect(refs).to.include('#/components/parameters/COIN');
            expect(refs).to.not.include('#/components/parameters/TYPE');
            expect(refs.filter(r => /parameters\/QUERY/.test(r))).to.deep.equal([]);
        });

        it(route + ' keeps its filtered sibling', function () {
            expect(api[route + '/{QUERY}/{TYPE}'][0]).to.equal(method);
            expect(SPEC.paths[route + '/{QUERY}/{TYPE}']).to.be.an('object');
        });
    }
});
