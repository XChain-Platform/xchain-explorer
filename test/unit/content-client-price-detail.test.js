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
 * PRICE detail render leg. Drives the SHIPPED showPriceDetails against the
 * SHIPPED #info-price markup sliced out of action.html, in the same harness
 * content-client-list-membership.test.js uses.
 *
 * What it protects: PRICE v1 (PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO) carries an
 * oracle usage FEE and an optional MEMO. The detail query selects both
 * (src/action-detail/consensus.js: `m.fee as oracle_fee`, `m1.memo`) but the
 * renderer read neither, so both were fetched per page view and dropped on the
 * floor: a user judging a submitted oracle quote could not see the fee attached
 * to it anywhere in the explorer. Query-selects-it / renderer-never-reads-it is
 * a silent failure by construction, which is what this test makes loud.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

// Slice a top-level function out of the source by walking braces, so the test
// runs shipped code rather than a copy that can drift.
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

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-price">');
    if (start < 0) throw new Error('#info-price panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-nodeproof"', start);
    if (end < 0) throw new Error('could not bound the #info-price panel');
    return ACTION_HTML.slice(start, end);
}

function renderPriceDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));

    dom.window.XC = { coin: 'BTC' };
    // Helpers the renderer leans on, kept naive so anything the assertions
    // observe is showPriceDetails' own doing.
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showPriceDetails'));
    dom.window.showPriceDetails(data);
    const $ = dom.window.$;
    const cell = (cls) => $('#info-price .' + cls).text().trim();
    return {
        version:   cell('price-version'),
        value:     cell('price-value'),
        oracleFee: cell('price-oracle-fee'),
        memo:      cell('price-memo'),
        status:    cell('price-validation-status'),
        html:      $('#info-price').html()
    };
}

const V1 = {
    version: 1, coin: 'BTC', tick: 'PEPE', fiat: 'USD', value: '0.00042',
    oracle_fee: '0.01', memo: 'quote from oracle A',
    round_number: null, round_timestamp: null, pairs: null, pair_count: null,
    sig_count: null, validation_status: 'valid'
};

describe('PRICE detail render: v1 oracle fee and memo reach the page', function () {

    it('[REGRESSION] renders the oracle fee, which the query fetched and the renderer dropped', function () {
        const out = renderPriceDetails(V1);
        expect(out.oracleFee).to.not.equal('');
        expect(out.oracleFee).to.not.equal('-');
        expect(out.oracleFee).to.contain('0.01');
        // FEE is a decimal fraction of 1, so the percent reading is the useful one.
        expect(out.oracleFee).to.contain('1%');
    });

    it('[REGRESSION] renders the memo', function () {
        expect(renderPriceDetails(V1).memo).to.equal('quote from oracle A');
    });

    it('shows a dash for a v0 validator snapshot, which carries neither field', function () {
        const out = renderPriceDetails({
            version: 0, coin: 'BTC', tick: null, fiat: 'USD', value: '64000.00',
            oracle_fee: null, memo: null, round_number: 42, round_timestamp: 1743638400,
            pairs: null, pair_count: 3, sig_count: 5, validation_status: 'valid'
        });
        expect(out.oracleFee).to.equal('-');
        expect(out.memo).to.equal('-');
        expect(out.oracleFee).to.not.contain('undefined');
        expect(out.memo).to.not.contain('undefined');
    });

    it('shows a dash for an empty memo rather than a blank cell', function () {
        expect(renderPriceDetails({ ...V1, memo: '' }).memo).to.equal('-');
    });

    it('escapes a memo carrying markup (the field is user-submitted)', function () {
        const out = renderPriceDetails({ ...V1, memo: '<img src=x onerror=alert(1)>' });
        expect(out.memo).to.equal('<img src=x onerror=alert(1)>');
        expect(out.html).to.not.contain('<img src=x');
        expect(out.html).to.contain('&lt;img');
    });

    it('renders a zero fee as zero, not as an absent field', function () {
        // FEE 0 is the common case and is meaningfully different from "no fee
        // field at all"; isNull must not swallow it.
        const out = renderPriceDetails({ ...V1, oracle_fee: '0' });
        expect(out.oracleFee).to.contain('0');
        expect(out.oracleFee).to.not.equal('-');
    });
});
