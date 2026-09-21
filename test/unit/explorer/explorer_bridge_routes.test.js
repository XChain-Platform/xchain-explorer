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
 **********************************************************************/

'use strict';

const fs           = require('fs');
const path         = require('path');
const proxyquire   = require('proxyquire');
const { expect }   = require('chai');

const ROOT       = path.resolve(__dirname, '../../..');
const TOKEN_PAGE = fs.readFileSync(path.join(ROOT, 'src/content/html/token.html'), 'utf8');
const TOKEN_LIFECYCLE = TOKEN_PAGE.slice(TOKEN_PAGE.indexOf('$(document).ready(function(){'));
const API_ROUTES = require('../../../src/explorer/routes/api_methods.js').api;
const Database   = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

const NEVER_SHIPPED = [
    '/{COIN}/api/bridge-invariant/{QUERY}',
    '/{COIN}/api/bridge-transfers/{QUERY}',
    '/{COIN}/api/applied-policy/{QUERY}'
];

/*
 * Turn direct $.getJSON('/' + XC.coin + '/api/...' + encodeURIComponent(...))
 * calls into the same templates used by api_methods.js. This audits the direct
 * request bypass that could otherwise replace the removed loader invocation.
 */
function directApiRoutes(source) {
    const routes = [];
    const call = /\$\.getJSON\s*\(\s*(['"])\/\1\s*\+\s*XC\.coin\s*\+\s*(['"])(\/api\/[^'"]*\/)\2\s*\+\s*encodeURIComponent\([^)]*\)/g;
    let match;
    while((match = call.exec(source)) !== null)
        routes.push('/{COIN}' + match[3] + '{QUERY}');
    return routes;
}

function unansweredDirectApiRoutes(source) {
    return directApiRoutes(source).filter((route) => !Object.hasOwn(API_ROUTES, route));
}

describe('token page bridge route coverage', function () {

    it('proves the former panel paths have no entry in the complete API route table', function () {
        for(const route of NEVER_SHIPPED)
            expect(API_ROUTES, route).to.not.have.property(route);
    });

    it('proves the proposed route methods have no database reader behind them', function () {
        for(const method of ['getBridgeInvariant', 'getBridgeTransfers', 'getAppliedPolicy'])
            expect(Database.prototype[method], method).to.equal(undefined);
    });

    it('requires every direct token-page lifecycle API call to exist in the complete route table', function () {
        expect(unansweredDirectApiRoutes(TOKEN_LIFECYCLE)).to.deep.equal([]);
    });

    it('fails the lifecycle audit when an unanswered bridge call is put back directly', function () {
        const counterexample = TOKEN_LIFECYCLE +
            "\n$.getJSON('/' + XC.coin + '/api/bridge-invariant/' + encodeURIComponent(tick), function(){});";
        expect(unansweredDirectApiRoutes(counterexample)).to.deep.equal([
            '/{COIN}/api/bridge-invariant/{QUERY}'
        ]);
    });

    it('keeps the token page on the executable token read', function () {
        const tokenRoute = API_ROUTES['/{COIN}/api/token/{QUERY}'];
        expect(tokenRoute).to.deep.equal(['getToken', 'token']);
        expect(Database.prototype[tokenRoute[0]]).to.be.a('function');
        expect(TOKEN_PAGE).to.contain("loadApiData(XC.coin, 'token', XC.query");
        expect(TOKEN_LIFECYCLE).to.not.match(/loadBridgePanels\s*\(/);
    });
});
