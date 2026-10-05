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
 *********************************************************************/

'use strict';

const { srcText } = require('../../../../helpers/source_text');

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');
const ACTION_HTML = fs.readFileSync(
    path.resolve(__dirname, '../../../../../src/content/html/action.html'), 'utf8');

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

function render(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(
        path.resolve(__dirname, '../../../../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(
        path.resolve(__dirname, '../../../../../src/content/js/numeral.js'), 'utf8'));
    dom.window.eval(`
        function isNull(v){ return v === null || v === undefined || v === ''; }
        function formatHash(value, len){ return String(value).substring(0, len); }
    `);
    dom.window.eval(extractFn('showPriceRounds'));
    dom.window.eval(extractFn('showPriceDetails'));
    dom.window.showPriceDetails(data);
    return dom.window.$;
}

describe('PRICE signature detail rendering', function () {
    it('marks malformed signatures and keeps the signers row visible', function () {
        const $ = render({ version: 0, signatures: [], signatures_unparseable: true });
        const count = $('#info-price .price-sig-count');
        const signers = $('#info-price .price-signers');

        expect(count.find('.text-danger').length).to.equal(1);
        expect(signers.find('.text-danger').length).to.equal(1);
        expect(count.text()).to.equal('unparseable');
        expect(signers.text()).to.equal('unparseable');
        expect($('#info-price .price-signers-row').hasClass('d-none')).to.equal(false);
    });

    it('renders a populated signature array unchanged', function () {
        const $ = render({ version: 0, signatures: [
            { pubkey: 'a'.repeat(32) },
            { pubkey: 'b'.repeat(32) }
        ] });

        expect($('#info-price .price-sig-count').text()).to.equal('2');
        expect($('#info-price .price-signers').html())
            .to.equal('a'.repeat(24) + '<br>' + 'b'.repeat(24));
        expect($('#info-price .price-signers-row').hasClass('d-none')).to.equal(false);
        expect($('#info-price .text-danger').length).to.equal(0);
    });

    it('keeps the explicit batch signature count unchanged', function () {
        const $ = render({ version: 0, sig_count: 7, signatures: [
            { pubkey: 'c'.repeat(32) }
        ] });

        expect($('#info-price .price-sig-count').text()).to.equal('7');
        expect($('#info-price .price-signers').text()).to.equal('c'.repeat(24));
        expect($('#info-price .price-signers-row').hasClass('d-none')).to.equal(false);
        expect($('#info-price .text-danger').length).to.equal(0);
    });
});
