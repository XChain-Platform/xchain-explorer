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
 * The /{COIN}/dispenser/{ADDRESS} route's client-side parameters.
 *
 * setXChainParams resolves XC.query from an allowlist of detail-page types,
 * and 'dispenser' was missing from it. The failure that causes is the one the
 * function's own comment warns about and is worth stating, because it is
 * quiet: XC.query stays null, the page titles itself "Dispenser null", and
 * every feed it asks for is requested with the address segment simply gone
 * (/RDOGE/explorer/dispensers/address), which the server answers as a route
 * that does not exist. Driven in a browser before the fix, that produced two
 * failed tables and an empty address row on a live dispenser.
 *
 * A dispenser is keyed by its operating GET_ADDRESS, so it is pinned here
 * against the same address branch 'address' and 'oracle' use, and NOT the
 * numeric branch - putting it in the wrong branch fails the same silent way.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');

// Slice a top-level function out of the source by walking braces (the same
// technique the sibling content-client tests use) so this runs shipped code
// rather than a copy that can drift.
function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

// A real base58 check, not the market test's stub: this route's whole question
// is whether an ADDRESS reaches XC.query, so stubbing the address test away
// would pin nothing.
const HELPERS = `
    function isNull(v){ return (v === null || v === undefined || v === '' || (typeof v === 'string' && v.toLowerCase() === 'null')); }
    function isNumeric(v){ return /^[0-9]+$/.test(String(v)); }
    function isCryptoAddress(v){ return /^[mn2A-Za-z1-9][a-km-zA-HJ-NP-Z1-9]{25,40}$/.test(String(v)); }
    function stripHtml(v){ return String(v); }
    function getXChainParam(coin, type){ return String(coin).toUpperCase(); }
`;

function paramsFor(url) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', url });
    dom.window.eval(HELPERS);
    dom.window.eval('var XC = { chains: {}, networks: {} };');
    dom.window.eval(extractFn('setXChainParams'));
    dom.window.setXChainParams('RDOGE');
    return { type: dom.window.XC.type, query: dom.window.XC.query };
}

describe('client: dispenser detail route parameters', function () {

    const ADDR = 'n4Vb25munK53vktnrdjsnWqpBfoyKFgio7';

    it('resolves the dispenser address into XC.query', function () {
        const p = paramsFor('http://explorer.test/RDOGE/dispenser/' + ADDR);
        expect(p.query).to.equal(ADDR);
        expect(p.type).to.equal('dispenser');
    });

    it('never leaves the query null, which is what emptied the feeds', function () {
        const p = paramsFor('http://explorer.test/RDOGE/dispenser/' + ADDR);
        expect(p.query).to.not.equal(null);
        expect(String(p.query)).to.not.contain('null');
    });

    it('resolves the same way the sibling address-keyed routes do', function () {
        const dispenser = paramsFor('http://explorer.test/RDOGE/dispenser/' + ADDR);
        const address   = paramsFor('http://explorer.test/RDOGE/address/' + ADDR);
        const oracle    = paramsFor('http://explorer.test/RDOGE/oracle/' + ADDR);
        expect(dispenser.query).to.equal(address.query);
        expect(dispenser.query).to.equal(oracle.query);
    });

    it('refuses a non-address dispenser query rather than passing it through', function () {
        // The numeric branch must not claim this route: a dispenser is not
        // keyed by action_index, and accepting one would send the feeds an id
        // they cannot scope by.
        // Left unset rather than null: the branch simply does not assign, and
        // the page's own XC literal supplies the default.
        expect(paramsFor('http://explorer.test/RDOGE/dispenser/1285').query).to.not.equal('1285');
    });

});
