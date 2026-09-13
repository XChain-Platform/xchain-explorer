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
 * Rich list / supply stats page (spec explorer-coverage-completion row 33,
 * M5.2). Drives the SHIPPED renders in src/content/js/rich-list-render.js and
 * the SHIPPED inline script of src/content/html/rich_list.html against stubbed
 * /api/rich_list payloads.
 *
 * What it protects, all of which are ways a rich list can be wrong while
 * rendering perfectly:
 *
 *  - TRUNCATION MUST BE VISIBLE. The ranking is a top-N over a larger census.
 *    A page that shows 100 rows and says nothing is telling a reader they are
 *    looking at the whole distribution.
 *
 *  - AN UNMEASURED PERCENT IS NOT ZERO. The server sends null when it cannot
 *    compute a share; rendering that as 0% says the largest holder owns none
 *    of the token.
 *
 *  - A SUPPLY DISAGREEMENT IS EVIDENCE. When the summed balances and the
 *    recorded supply differ, the index has a problem and the page shows both
 *    figures rather than quietly picking whichever makes the percentages add
 *    up.
 *
 *  - NOT FOUND IS AN EXPLICIT BRANCH. A tick can be interned without ever
 *    having been issued.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/rich-list-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/rich_list.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');

function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// isNull and isNumeric are the REAL ones: the unmeasured-percent verdict and
// the supply-mismatch comparison are both expressed through them.
function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = { coin: 'RDOGE', query: 'RARETOKEN', network: 'regtest', name: 'Dogecoin', pageInfo: {}, datatables: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function updatePageInfo(){}
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(XCHAIN_SRC, 'isNull')}
        ${extractFn(XCHAIN_SRC, 'isNumeric')}
    `);
    dom.window.eval(RENDER_SRC);
}

function renderDom() {
    const dom = new JSDOM('<!DOCTYPE html><body><table><tbody id="out"></tbody></table><div id="html"></div></body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    return dom;
}

function paintRows(dom, html) {
    dom.window.$('#out').html(html);
    return dom.window.$;
}

function paint(dom, html) {
    dom.window.$('#html').html(html);
    return dom.window.$;
}

function loadPage(routes) {
    const bodyHtml = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("rich_list.html's inline ready block was not found");
    const inline = PAGE_HTML.slice(scriptStart, PAGE_HTML.lastIndexOf('</script>'));

    const dom = new JSDOM('<!DOCTYPE html><body>' + bodyHtml + '</body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    dom.window.eval('jQuery.fn.ready = function(fn){ fn(jQuery); return this; };');

    const seen = [];
    dom.window.$.getJSON = function (url, cb) {
        seen.push(url);
        const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
        let xhr = null;
        if (r === undefined) {
            xhr = { status: 404, responseJSON: { error: 'not found', code: 'NOT_FOUND' } };
        } else if (r && r.__fail) {
            xhr = r.__fail;
        } else {
            cb(r);
        }
        return { fail: function (f) { if (xhr) f(xhr); return this; } };
    };

    dom.window.eval(inline);
    return { $: dom.window.$, seen, window: dom.window };
}

/* ------------------------------- fixtures ------------------------------- */

// A truncated ranking: 3 rows shown out of a 4,812-address census.
const TRUNCATED = {
    tick: 'RARETOKEN', supply: '1000', max_supply: '5000', max_mint: null, decimals: 0,
    lock_max_supply: 0, lock_mint: 0, description: null, owner: 'mOwner',
    action_index: 90, block_index: 800,
    holder_count: 4812, held_total: '1000', ranked_count: 3,
    top_holder_percent: '60.00000000', top_ten_percent: null,
    holders: [
        { rank: 1, address: 'mWhale', amount: '600', percent: '60.00000000' },
        { rank: 2, address: 'mMid',   amount: '300', percent: '30.00000000' },
        { rank: 3, address: 'mSmall', amount: '100', percent: '10.00000000' }
    ]
};

const COMPLETE = Object.assign({}, TRUNCATED, { holder_count: 3, ranked_count: 3 });

describe('rich list and supply stats (M5.2)', function () {

    describe('supply panel', function () {

        it('marks a locked ceiling as locked and an unlocked one as able to rise', function () {
            const dom = renderDom();
            let $ = paintRows(dom, dom.window.renderRichListSupply(TRUNCATED));
            expect($('.rich-list-ceiling-open').length).to.equal(1);
            expect($('.rich-list-ceiling-locked').length).to.equal(0);

            $ = paintRows(dom, dom.window.renderRichListSupply(Object.assign({}, TRUNCATED, { lock_max_supply: 1 })));
            expect($('.rich-list-ceiling-locked').length).to.equal(1);
        });

        it('says the top-ten concentration was NOT MEASURED rather than showing zero', function () {
            const dom = renderDom();
            const $ = paintRows(dom, dom.window.renderRichListSupply(TRUNCATED));
            expect($('.rich-list-topten-unmeasured').length).to.equal(1);
            expect($('.rich-list-topten-unmeasured').text()).to.include('not measured');
        });

        it('shows a supply disagreement instead of smoothing it away', function () {
            const dom = renderDom();
            const $ = paintRows(dom, dom.window.renderRichListSupply(
                Object.assign({}, TRUNCATED, { held_total: '900' })));
            expect($('.rich-list-supply-mismatch').length).to.equal(1);
        });

        it('shows no mismatch when the two figures differ only in trailing zeros', function () {
            // '1000' and '1000.00000000' are the SAME number arriving from two
            // VARCHAR columns; flagging that as ledger drift would cry wolf on
            // every token and train readers to ignore the real warning.
            const dom = renderDom();
            const $ = paintRows(dom, dom.window.renderRichListSupply(
                Object.assign({}, TRUNCATED, { held_total: '1000.00000000' })));
            expect($('.rich-list-supply-mismatch').length).to.equal(0);
        });

        it('renders an unmeasurable largest-holder share as n/a, never as 0%', function () {
            const dom = renderDom();
            const $ = paintRows(dom, dom.window.renderRichListSupply(
                Object.assign({}, TRUNCATED, { top_holder_percent: null })));
            expect($('.rich-list-percent-unknown').length).to.be.greaterThan(0);
        });
    });

    describe('holder ranking', function () {

        it('renders one row per ranked holder, carrying the server rank', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListHolders(TRUNCATED));
            expect($('.rich-list-row').length).to.equal(3);
            expect($('.rich-list-row').first().attr('data-rank')).to.equal('1');
        });

        it('keeps a page-2 rank instead of renumbering from 1', function () {
            // Two addresses both rendering as "#1 holder" is the defect.
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListHolders(Object.assign({}, TRUNCATED, {
                holders: [{ rank: 101, address: 'mLater', amount: '5', percent: '0.50000000' }]
            })));
            expect($('.rich-list-row').attr('data-rank')).to.equal('101');
        });

        it('says the ranking is a TOP-N when the census is larger', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListCoverage(TRUNCATED));
            expect($('.rich-list-coverage').text()).to.include('not the full distribution');
        });

        it('says it is showing ALL holders when nothing was truncated', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListCoverage(COMPLETE));
            expect($('.rich-list-coverage').text()).to.include('all');
            expect($('.rich-list-coverage').text()).to.not.include('not the full distribution');
        });

        it('renders an explicit empty state for a token nobody holds', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListHolders(
                Object.assign({}, TRUNCATED, { holders: [] })));
            expect($('.rich-list-empty').length).to.equal(1);
        });

        it('escapes a hostile address instead of executing it', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderRichListHolders(Object.assign({}, TRUNCATED, {
                holders: [{ rank: 1, address: '<img src=x onerror=alert(1)>', amount: '1', percent: '1.00000000' }]
            })));
            expect($('.rich-list-address img').length).to.equal(0);
        });
    });

    describe('the shipped page', function () {

        it('requests the rich list for the page tick', function () {
            const { seen } = loadPage({ '/RDOGE/api/rich_list/RARETOKEN': TRUNCATED });
            expect(seen).to.deep.equal(['/RDOGE/api/rich_list/RARETOKEN']);
        });

        it('renders supply, ranking and the coverage note together', function () {
            const { $ } = loadPage({ '/RDOGE/api/rich_list/RARETOKEN': TRUNCATED });
            expect($('#rich-list-supply tr').length).to.be.greaterThan(3);
            expect($('#rich-list-holders .rich-list-row').length).to.equal(3);
            expect($('#rich-list-coverage').text()).to.include('not the full distribution');
        });

        it('accepts the {total,data} envelope as well as a bare object', function () {
            const { $ } = loadPage({ '/RDOGE/api/rich_list/RARETOKEN': { total: 1, data: [TRUNCATED] } });
            expect($('#rich-list-holders .rich-list-row').length).to.equal(3);
        });

        it('renders an explicit not-found for a tick that was never issued', function () {
            const { $ } = loadPage({ '/RDOGE/api/rich_list/RARETOKEN': null });
            expect($('#rich-list-supply').text()).to.include('No token is issued under this tick');
        });

        it('renders a transport failure as an error, not as an empty token', function () {
            const { $ } = loadPage({
                '/RDOGE/api/rich_list/RARETOKEN': { __fail: { status: 503, responseJSON: { error: 'index unavailable' } } }
            });
            expect($('.rich-list-error').length).to.equal(1);
            expect($('.rich-list-error').text()).to.include('index unavailable');
        });
    });
});
