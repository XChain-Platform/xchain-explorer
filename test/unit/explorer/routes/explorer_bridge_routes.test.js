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

const ROOT       = path.resolve(__dirname, '../../../..');
const TOKEN_PAGE = fs.readFileSync(path.join(ROOT, 'src/content/html/token.html'), 'utf8');
const TOKEN_LIFECYCLE = TOKEN_PAGE.slice(TOKEN_PAGE.indexOf('$(document).ready(function(){'));
const API_ENTRY = fs.readFileSync(path.join(ROOT, 'src/api.js'), 'utf8');
const BRIDGE_ROUTES = fs.readFileSync(path.join(ROOT, 'src/http/bridge_panel_routes.js'), 'utf8');
const API_ROUTES = require('../../../../src/explorer/routes/api_methods.js').api;
const Database   = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

const BRIDGE_PANEL_ROUTES = [
    '/{COIN}/api/bridge-invariant/{QUERY}',
    '/{COIN}/api/bridge-transfers/{QUERY}',
    '/{COIN}/api/applied-policy/{QUERY}'
];

/*
 * Normalize direct $.getJSON calls to the templates used by api_methods.js.
 * Include pre-wildcard registrations because these calls bypass that table.
 */
function directApiRoutes(source) {
    const routes = [];
    const call = /\$\.getJSON\s*\(\s*(['"])\/\1\s*\+\s*XC\.coin\s*\+\s*(['"])(\/api\/[^'"]*\/)\2\s*\+\s*encodeURIComponent\([^)]*\)/g;
    let match;
    while((match = call.exec(source)) !== null)
        routes.push('/{COIN}' + match[3] + '{QUERY}');
    return routes;
}

function specialApiRoutes(source) {
    const routes = new Set();
    for(const match of source.matchAll(/app\.get\('(\/:coin\/api\/[^']*)'/g))
        routes.add(match[1].replace('/:coin', '/{COIN}').replace(/:tick/g, '{QUERY}'));
    return routes;
}

function unansweredDirectApiRoutes(source) {
    const special = specialApiRoutes(API_ENTRY + '\n' + BRIDGE_ROUTES);
    return directApiRoutes(source).filter((route) => !Object.hasOwn(API_ROUTES, route) && !special.has(route));
}

describe('token page bridge route coverage', function () {

    it('pins every panel path to a pre-wildcard JSON route', function () {
        const special = specialApiRoutes(API_ENTRY + '\n' + BRIDGE_ROUTES);
        for(const route of BRIDGE_PANEL_ROUTES)
            expect(special, route).to.include(route);
    });

    it('pins the local panel paths to installed database readers', function () {
        for(const method of ['getBridgeTransfers', 'getAppliedPolicy'])
            expect(Database.prototype[method], method).to.be.a('function');
    });

    it('requires every direct token-page lifecycle API call to exist in the complete route table', function () {
        expect(unansweredDirectApiRoutes(TOKEN_LIFECYCLE)).to.deep.equal([]);
    });

    it('fails the lifecycle audit when an unanswered bridge call is put back directly', function () {
        const counterexample = TOKEN_LIFECYCLE +
            "\n$.getJSON('/' + XC.coin + '/api/missing-bridge/' + encodeURIComponent(tick), function(){});";
        expect(unansweredDirectApiRoutes(counterexample)).to.deep.equal([
            '/{COIN}/api/missing-bridge/{QUERY}'
        ]);
    });

    it('loads the bridge panels only after the token read resolves', function () {
        const tokenRoute = API_ROUTES['/{COIN}/api/token/{QUERY}'];
        expect(tokenRoute).to.deep.equal(['getToken', 'token']);
        expect(Database.prototype[tokenRoute[0]]).to.be.a('function');
        expect(TOKEN_PAGE).to.contain("loadApiData(XC.coin, 'token', XC.query");
        expect(TOKEN_LIFECYCLE).to.match(/loadApiData[\s\S]*loadBridgePanels\(tick\)/);
    });
});
