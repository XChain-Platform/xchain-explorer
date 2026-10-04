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

const { srcText } = require('../../../../helpers/source_text');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/action.html'), 'utf8');

function extractFn(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for(; i < SRC.length; i++) {
        if(SRC[i] === '{') depth++;
        else if(SRC[i] === '}') { depth--; if(depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-price">');
    if(start < 0) throw new Error('#info-price panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-nodeproof"', start);
    if(end < 0) throw new Error('could not bound the #info-price panel');
    return ACTION_HTML.slice(start, end);
}

function renderPriceDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function isNull(value){ return value === null || value === undefined || value === ''; }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function tokenUrl(coin, tick){ return '/' + coin + '/token/' + tick; }
        function formatHash(value){ return String(value); }
        function showPriceRounds(){}
    `);
    dom.window.eval(extractFn('showPricePairCount'));
    dom.window.eval(extractFn('showPriceDetails'));
    dom.window.showPriceDetails(data);
    return dom.window.$('#info-price .price-pairs');
}

const BASE = {
    version: 0, coin: 'BTC', tick: null, fiat: 'USD', value: '64000.00',
    oracle_fee: null, memo: null, round_number: 42, round_timestamp: 1743638400,
    pairs: null, pair_count: null, sig_count: null, validation_status: 'valid',
    signatures: [], rounds: []
};

describe('PRICE detail render: malformed pairs JSON', function () {
    it('shows an error marker instead of the pair_count fallback', function () {
        const cell = renderPriceDetails({ ...BASE, pairs: [], pair_count: 7, pairs_unparseable: true });
        expect(cell.find('.text-danger').length).to.equal(1);
        expect(cell.text()).to.match(/unparseable/i);
        expect(cell.text()).to.not.equal('7');
    });

    it('renders the length of a normal pairs array unchanged', function () {
        const cell = renderPriceDetails({ ...BASE, pairs: [{}, {}], pair_count: 7 });
        expect(cell.text()).to.equal('2');
        expect(cell.find('.text-danger').length).to.equal(0);
    });

    it('keeps the per-round fallback for a batch row', function () {
        const cell = renderPriceDetails({
            ...BASE, rounds: [{ pairs: [{}, {}, {}] }]
        });
        expect(cell.text()).to.equal('3 per round');
        expect(cell.find('.text-danger').length).to.equal(0);
    });
});
