/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * A market page URL may carry one tick (/{COIN}/market/{TICK}) or two. The
 * client used to read the counter-tick straight from the fourth path segment,
 * so a single-tick URL stringified the missing segment into the page title
 * ("XCHAIN / undefined Market Information") and into an API request for a
 * nonexistent 'undefined' ticker, which then returned no row and left every
 * panel silently on "Loading".
 *
 * These assertions pin the resolution path: a single-tick URL resolves its
 * counter-tick from the market list for that tick, a URL-supplied counter
 * passes through, and a pair that does not resolve renders a visible
 * not-found state rather than a blank or a literal "undefined".
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const MARKET_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/market.html'), 'utf8');

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

// Common client helpers every extracted function leans on.
const HELPERS = `
    function isNull(v){ return (v === null || v === undefined || v === '' || (typeof v === 'string' && v.toLowerCase() === 'null')); }
    function isNumeric(v){ return /^[0-9]+$/.test(String(v)); }
    function isCryptoAddress(v){ return false; }
    function stripHtml(v){ return String(v); }
    function getXChainParam(coin, type){ return String(coin).toUpperCase(); }
`;

describe('client: market page counter-tick resolution', function () {

    // setXChainParams derives XC.query from the path; a single-tick market URL
    // must not stringify a missing segment.
    function queryFor(url) {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', url });
        dom.window.eval(HELPERS);
        dom.window.eval('var XC = { chains: {}, networks: {} };');
        dom.window.eval(extractFn('setXChainParams'));
        dom.window.setXChainParams('RDOGE');
        return dom.window.XC.query;
    }

    it('a single-tick market URL yields the tick alone, never "undefined"', function () {
        const q = queryFor('https://explorer.test/RDOGE/market/XCHAIN');
        expect(q).to.equal('XCHAIN');
        expect(String(q)).to.not.contain('undefined');
    });

    it('a two-tick market URL yields the full pair', function () {
        expect(queryFor('https://explorer.test/RDOGE/market/XCHAIN/RDOGE')).to.equal('XCHAIN/RDOGE');
    });

    // resolveMarketPair supplies the counter-tick a single-tick URL omits.
    function resolver(marketsResponse) {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        dom.window.eval(HELPERS);
        dom.window.eval('var XC = { coin: "RDOGE" };');
        dom.window.calls = [];
        dom.window.eval(`
            function loadApiData(coin, action, query, type, cb){
                calls.push('/' + coin + '/api/' + action + '/' + query);
                cb(${JSON.stringify(marketsResponse)});
            }
        `);
        dom.window.eval(extractFn('resolveMarketPair'));
        return dom.window;
    }

    it('passes a URL-supplied counter-tick through without an API call', function () {
        const w = resolver(null);
        let got = null;
        w.resolveMarketPair('XCHAIN', 'RDOGE', function (t) { got = t; }, function () { got = 'FAIL'; });
        expect(got).to.equal('RDOGE');
        expect(w.calls).to.have.length(0);
    });

    it('resolves a missing counter-tick from the market list for the tick', function () {
        const w = resolver({ total: 1, data: [{ tick1: 'XCHAIN', tick2: 'DANK' }] });
        let got = null;
        w.resolveMarketPair('XCHAIN', undefined, function (t) { got = t; });
        expect(got).to.equal('DANK');
        expect(w.calls).to.deep.equal(['/RDOGE/api/markets/XCHAIN']);
    });

    it('resolves the counter regardless of pair orientation in the list', function () {
        // The markets list re-orients pairs around the searched tick, so the
        // searched tick can come back on either side of the row.
        const w = resolver({ total: 1, data: [{ tick1: 'DANK', tick2: 'XCHAIN' }] });
        let got = null;
        w.resolveMarketPair('XCHAIN', undefined, function (t) { got = t; });
        expect(got).to.equal('DANK');
    });

    it('reports failure when no market exists for the tick', function () {
        const w = resolver({ total: 0, data: [] });
        let got = null, failed = false;
        w.resolveMarketPair('NOPE', undefined, function (t) { got = t; }, function () { failed = true; });
        expect(got).to.equal(null);
        expect(failed).to.equal(true);
    });

    // loadApiData must know the plural 'markets' list endpoint the resolver
    // uses; the naive '-s' suffix branch would have built '/api/marketss'.
    it('loadApiData maps the markets action to /api/markets', function () {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        dom.window.eval('var XC = { debug: false }; var urls = [];');
        dom.window.eval('var $ = { getJSON: function(url){ urls.push(url); } };');
        dom.window.eval(extractFn('loadApiData'));
        dom.window.loadApiData('RDOGE', 'markets', 'XCHAIN', null, function () {});
        expect(dom.window.urls).to.deep.equal(['/RDOGE/api/markets/XCHAIN']);
    });

    // updateMarketBasics answers for the pair the API actually resolved; a
    // missing row must surface, not leave the page half-composed.
    function basics(apiResponse) {
        const dom = new JSDOM(
            '<!DOCTYPE html><body>' +
            '<span class="tick1-name"></span><span class="tick2-name"></span>' +
            '<a id="market-swap-button" href="#"></a>' +
            '</body>', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
        dom.window.eval(HELPERS);
        dom.window.eval(`
            var XC = { coin: 'RDOGE' };
            var notFound = null;
            function showMarketNotFound(tick){ notFound = tick; }
            function loadApiData(coin, action, query, type, cb){ cb(${JSON.stringify(apiResponse)}); }
            function getTokenIcon(){ return '/icon/default.png'; }
            function formatAmount(v){ return String(v); }
            function bcformat(v){ return String(v); }
        `);
        dom.window.eval(extractFn('updateMarketBasics'));
        dom.window.updateMarketBasics('XCHAIN/NOPE');
        return dom.window;
    }

    it('a market that does not resolve renders the visible not-found state', function () {
        // The API answers `false` for an unknown pair (no row matched), and
        // loadApiData passes that straight to the callback.
        const w = basics(false);
        expect(w.notFound).to.equal('XCHAIN');
        expect(w.$('.tick2-name').text()).to.equal('');
    });

    it('a resolved market populates the pair header from the API row', function () {
        const w = basics({ tick1: 'XCHAIN', tick2: 'DANK', tick1_price: '1' });
        expect(w.notFound).to.equal(null);
        expect(w.$('.tick1-name').text()).to.equal('XCHAIN');
        expect(w.$('.tick2-name').text()).to.equal('DANK');
        expect(w.$('#market-swap-button').attr('href')).to.equal('/RDOGE/market/DANK/XCHAIN');
    });

    // The page fragment must route its composition through the resolver; raw
    // concatenation of the fourth path segment is what printed "undefined".
    it('market.html composes its title through resolveMarketPair', function () {
        expect(MARKET_HTML).to.contain('resolveMarketPair(');
        expect(MARKET_HTML).to.not.contain("path[3] + ' / ' + path[4]");
    });

});
