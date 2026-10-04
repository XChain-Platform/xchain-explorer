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
const NETWORK_COIN_SRC = require('../../../../helpers/content-source.js').networkCoinSource();
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../../../../src/content/js/formatters.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(
    path.resolve(__dirname, '../../../../../src/content/html/action.html'), 'utf8');

function extractFn(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error('unterminated function: ' + name);
}

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-price">');
    const end = ACTION_HTML.indexOf('id="info-nodeproof"', start);
    if (start < 0 || end < 0) throw new Error('could not bound the #info-price panel');
    return ACTION_HTML.slice(start, end);
}

function renderPriceDetails(data, priorData) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(
        path.resolve(__dirname, '../../../../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(
        path.resolve(__dirname, '../../../../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = {
        coin: 'TBTC', network: 'testnet',
        networks: { mainnet: '', testnet: 'T', regtest: 'R' }
    };
    dom.window.eval(NETWORK_COIN_SRC);
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(h, len){ return String(h).substring(0, len); }
        function formatLivestamp(ts){ return '<span data-livestamp=' + ts + '></span>'; }
        ${extractFn('isNull')}
        ${extractFn('tokenUrl')}
        ${extractFn('nullToBlank')}
        ${extractFn('escapeHtml')}
    `);
    dom.window.eval(extractFn('formatPriceAnchorHeight'));
    dom.window.eval(extractFn('showPriceRounds'));
    dom.window.eval(extractFn('showPriceDetails'));
    if (priorData) dom.window.showPriceDetails(priorData);
    dom.window.showPriceDetails(data);
    const $ = dom.window.$;
    return {
        hidden: $('#info-price .price-rounds-block').hasClass('d-none'),
        summary: $('#info-price .price-rounds-summary').text().trim(),
        text: $('#info-price .price-rounds').text().trim(),
        html: $('#info-price .price-rounds').html(),
        markers: $('#info-price .price-rounds .text-danger').length
    };
}

const BASE = {
    version: 1, coin: 'BTC', tick: 'TOKEN', fiat: 'USD', value: '1.00',
    oracle_fee: null, memo: null, round_number: null, round_timestamp: null,
    pairs: null, pair_count: null, sig_count: null, signatures: [],
    batch_first_round: null, batch_last_round: null, round_count: null,
    validation_status: 'valid', rounds: []
};

const POPULATED = {
    ...BASE,
    version: 0,
    rounds: [{
        round: 42, timestamp: 1788123601, btc_block_height: 150436,
        pairs: [{ pair: 'BTC/USD', price: '78600.74000000' }]
    }]
};

describe('PRICE detail rounds parse failure', function () {
    it('shows an error marker and clears a prior rounds summary', function () {
        const out = renderPriceDetails(
            { ...BASE, rounds: [], rounds_unparseable: true }, POPULATED);
        expect(out.hidden).to.equal(false);
        expect(out.markers).to.equal(1);
        expect(out.text).to.equal('Invalid rounds JSON');
        expect(out.summary).to.equal('');
    });

    it('renders populated rounds unchanged when the parse flag is absent', function () {
        const out = renderPriceDetails(POPULATED);
        expect(out.hidden).to.equal(false);
        expect(out.markers).to.equal(0);
        expect(out.summary).to.equal('(1 round, 1 price)');
        expect(out.text).to.include('BTC');
        expect(out.text).to.include('USD');
        expect(out.text).to.include('78600.74000000');
        expect(out.html).to.include('<table');
    });

    it('keeps ordinary rows with no rounds hidden', function () {
        for (const version of [0, 1]) {
            const out = renderPriceDetails({ ...BASE, version, rounds: [] });
            expect(out.hidden, 'version ' + version).to.equal(true);
            expect(out.markers, 'version ' + version).to.equal(0);
            expect(out.text, 'version ' + version).to.equal('');
        }
    });
});
