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
 * Collectibles gallery (spec explorer-coverage-completion row 32, M5.1).
 * Drives the SHIPPED renders in src/content/js/collectibles-gallery-render.js
 * and the SHIPPED inline script of src/content/html/collectibles.html against
 * stubbed endpoint payloads, in the same JSDOM harness the other
 * content-client-* tests use.
 *
 * What it protects:
 *
 *  - CLASSIFICATION. A divisible token rendered in a gallery of collectibles is
 *    a false claim about what the holder owns. The server filters, and the
 *    client re-checks through the SHIPPED isNftToken so there is one rule in
 *    the browser rather than two.
 *
 *  - FROZEN CEILING IS NOT A CLOSED EDITION. lock_max_supply caps how many can
 *    ever exist; lock_mint says whether more can still be created up to that
 *    cap. A gallery reader assumes the stronger promise, so an open mint is
 *    called out rather than left to inference.
 *
 *  - A FAILED FETCH IS NOT AN EMPTY CHAIN. "No collectibles yet" is a statement
 *    about the ledger. A page that says it when the request failed is lying.
 *
 *  - SUPPLY AS A COUNT. These tokens are indivisible by definition, so a
 *    decimal-formatted supply would print places that cannot exist.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/collectibles-gallery-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/collectibles.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');

// Slice a top-level function out of the source by walking braces, so the test
// runs shipped code rather than a copy that can drift.
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

// isNull, isNumeric, isNftToken and getTokenIcon are the REAL ones: the
// classification verdict and the edition label are expressed through them, so a
// stub would test the stub.
function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = { coin: 'RDOGE', network: 'regtest', name: 'Dogecoin', pageInfo: {}, datatables: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function updatePageInfo(){}
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(XCHAIN_SRC, 'isNull')}
        ${extractFn(XCHAIN_SRC, 'isNumeric')}
        ${extractFn(XCHAIN_SRC, 'isNftToken')}
        ${extractFn(XCHAIN_SRC, 'getTokenIcon')}
    `);
    dom.window.eval(RENDER_SRC);
}

function renderDom() {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="out" class="row"></div></body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    return dom;
}

function paint(dom, html) {
    dom.window.$('#out').html(html);
    return dom.window.$;
}

function loadPage(routes) {
    const bodyHtml = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("collectibles.html's inline ready block was not found");
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

const ONE_OF_ONE = {
    id: 5, tick: 'RAREART', supply: '1', max_supply: '1', decimals: 0,
    lock_max_supply: 1, lock_mint: 1, description: 'a single piece',
    owner: 'mOwnerAddr', block_index: 2400, timestamp: 1700000000,
    tx_hash: 'aa', action_index: 1200
};

// Ceiling frozen at 100, mint still OPEN: only 37 exist so far and more can be
// created. A gallery that renders this identically to the 1-of-1 above is
// making a promise the token has not made.
const OPEN_EDITION = Object.assign({}, ONE_OF_ONE, {
    id: 6, tick: 'OPENED', supply: '37', max_supply: '100', lock_mint: 0, action_index: 1201
});

// Divisible. Must never reach the grid even if the server serves it.
const DIVISIBLE = Object.assign({}, ONE_OF_ONE, {
    id: 7, tick: 'MONEY', decimals: 8, lock_max_supply: 1, action_index: 1202
});

// Indivisible but the ceiling can still move: not a collectible either.
const UNCAPPED = Object.assign({}, ONE_OF_ONE, {
    id: 8, tick: 'UNCAPPED', decimals: 0, lock_max_supply: 0, action_index: 1203
});

describe('collectibles gallery (M5.1)', function () {

    describe('classification', function () {

        it('renders a card for an indivisible token with a frozen ceiling', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([ONE_OF_ONE]));
            expect($('.collectible-card').length).to.equal(1);
            expect($('.collectible-card').attr('data-tick')).to.equal('RAREART');
        });

        it('drops a DIVISIBLE token the server should never have served', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([ONE_OF_ONE, DIVISIBLE]));
            expect($('.collectible-card').length).to.equal(1);
            expect($('.collectible-card').attr('data-tick')).to.equal('RAREART');
        });

        it('drops an indivisible token whose ceiling is NOT locked', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([UNCAPPED]));
            expect($('.collectible-card').length).to.equal(0);
        });

        it('uses the shipped isNftToken rather than a second copy of the rule', function () {
            expect(RENDER_SRC).to.include('isNftToken(row.decimals, row.lock_max_supply)');
        });
    });

    describe('what a card claims', function () {

        it('renders supply as a COUNT of an edition, not as a divisible amount', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([OPEN_EDITION]));
            expect($('.collectible-edition').text()).to.equal('37 of 100');
        });

        it('names a still-open mint, so a frozen ceiling is not read as a closed edition', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([OPEN_EDITION]));
            expect($('.collectible-mint-open').length).to.equal(1);
        });

        it('marks nothing on a token whose mint is closed', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([ONE_OF_ONE]));
            expect($('.collectible-mint-open').length).to.equal(0);
        });

        it('omits the edition line entirely when supply is unreadable', function () {
            // Better than printing "null of null" under the artwork.
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([
                Object.assign({}, ONE_OF_ONE, { supply: null, max_supply: null })
            ]));
            expect($('.collectible-card').length).to.equal(1);
            expect($('.collectible-edition').length).to.equal(0);
        });

        it('escapes a hostile description instead of executing it', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([
                Object.assign({}, ONE_OF_ONE, { description: '<img src=x onerror=alert(1)>' })
            ]));
            expect($('.collectible-description img').length).to.equal(0);
            expect($('.collectible-description').text()).to.include('<img');
        });

        it('renders a TIS description as text, never as a link', function () {
            // A user-supplied URL rendered as a link from a list page is an
            // open-redirect surface for no benefit; the gallery fetches nothing.
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([
                Object.assign({}, ONE_OF_ONE, { description: 'https://example.invalid/tis.json' })
            ]));
            expect($('.collectible-description a').length).to.equal(0);
        });
    });

    describe('empty and paging', function () {

        it('says the chain has none, and says what the rule is', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderCollectiblesGallery([]));
            expect($('.collectibles-empty').length).to.equal(1);
            expect($('.collectibles-empty').text()).to.include('indivisible');
        });

        it('renders no pager when everything fits on one page', function () {
            const dom = renderDom();
            expect(dom.window.renderCollectiblesPager(1, 10, 24)).to.equal('');
        });

        it('disables Previous on the first page and Next on the last', function () {
            const dom = renderDom();
            let $ = paint(dom, dom.window.renderCollectiblesPager(1, 50, 24));
            expect($('.collectibles-prev').closest('li').hasClass('disabled')).to.equal(true);
            expect($('.collectibles-next').closest('li').hasClass('disabled')).to.equal(false);

            $ = paint(dom, dom.window.renderCollectiblesPager(3, 50, 24));
            expect($('.collectibles-next').closest('li').hasClass('disabled')).to.equal(true);
        });
    });

    describe('the shipped page', function () {

        it('requests the collectibles route with its own page size', function () {
            const { seen } = loadPage({
                '/RDOGE/api/collectibles?page=1&limit=24': { total: 2, data: [ONE_OF_ONE, OPEN_EDITION] }
            });
            expect(seen).to.deep.equal(['/RDOGE/api/collectibles?page=1&limit=24']);
        });

        it('renders the grid and the total count', function () {
            const { $ } = loadPage({
                '/RDOGE/api/collectibles?page=1&limit=24': { total: 2, data: [ONE_OF_ONE, OPEN_EDITION] }
            });
            expect($('#collectibles-grid .collectible-card').length).to.equal(2);
            expect($('#collectibles-count').text()).to.include('2');
        });

        it('a FAILED fetch renders an error, never "no collectibles yet"', function () {
            // The defect this prevents: telling a reader the ledger holds nothing
            // when in fact the request did not complete.
            const { $ } = loadPage({
                '/RDOGE/api/collectibles?page=1&limit=24': { __fail: { status: 503, responseJSON: { error: 'upstream is down' } } }
            });
            expect($('.collectibles-error').length).to.equal(1);
            expect($('.collectibles-error').text()).to.include('upstream is down');
            expect($('.collectibles-empty').length).to.equal(0);
        });

        it('an EMPTY result renders the empty state, not an error', function () {
            const { $ } = loadPage({
                '/RDOGE/api/collectibles?page=1&limit=24': { total: 0, data: [] }
            });
            expect($('.collectibles-empty').length).to.equal(1);
            expect($('.collectibles-error').length).to.equal(0);
        });
    });
});
