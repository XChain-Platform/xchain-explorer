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

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
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

    dom.window.XC = { coin: 'BTC', network: 'testnet', networks: { mainnet: '', testnet: 'T', regtest: 'R' }, ...(data.__xc || {}) };
    // Helpers the renderer leans on, kept naive so anything the assertions
    // observe is showPriceDetails' own doing. escapeHtml and nullToBlank are
    // pulled from the shipped source rather than stubbed, because the round
    // renderer's escaping IS one of the things under test here.
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(h, len){ return String(h).substring(0, len); }
        function formatLivestamp(ts){ return '<span data-livestamp=' + ts + '></span>'; }
        ${extractFn('isNull')}
        ${extractFn('nullToBlank')}
        ${extractFn('escapeHtml')}
    `);
    dom.window.eval(extractFn('formatPriceAnchorHeight'));
    dom.window.eval(extractFn('showPriceRounds'));
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
        pairs:     cell('price-pairs'),
        sigCount:  cell('price-sig-count'),
        window:    cell('price-window'),
        signers:   cell('price-signers'),
        rounds:    cell('price-rounds'),
        summary:   cell('price-rounds-summary'),
        roundsHidden:  $('#info-price .price-rounds-block').hasClass('d-none'),
        windowHidden:  $('#info-price .price-window-row').hasClass('d-none'),
        signersHidden: $('#info-price .price-signers-row').hasClass('d-none'),
        roundsHtml: $('#info-price .price-rounds').html(),
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

    it('hides the batch rows for a v1 oracle, which carries no round window', function () {
        const out = renderPriceDetails(V1);
        expect(out.windowHidden).to.equal(true);
        expect(out.roundsHidden).to.equal(true);
        expect(out.signersHidden).to.equal(true);
    });
});

// A validator PRICE on the wire is a BATCH: one signed action carrying an hourly
// window of rounds, each a full COIN/FIAT set. The indexer stores NULL in
// pair_count / pairs_json / sig_count for one (they would describe a single round
// out of the window) and puts the real data in rounds_json + the batch window
// columns. Selecting and rendering only the single-round columns is what made a
// batch render as a page of dashes over prices it plainly carried.
const BATCH = {
    version: 0, coin: null, tick: null, fiat: null, value: null,
    oracle_fee: null, memo: null,
    round_number: 414, round_timestamp: null,
    pairs: null, pair_count: null, sig_count: null,
    batch_first_round: 414, batch_last_round: 415, round_count: 2,
    signatures: [
        { pubkey: 'c1de91459e8bd93de9e3263c26d886058593d3fdae57ad0c1bd48ca3dd22f32a', sig: 'aa' },
        { pubkey: '2661bd8f42b910bbb471387b7c28eaa440fc3c99077c160a69f22859f924aa7d', sig: 'bb' }
    ],
    rounds: [
        { round: 414, timestamp: 1788123601, btc_block_height: 150436,
          pairs: [{ pair: 'BTC/USD', price: '78600.74000000' }, { pair: 'DOGE/EUR', price: '0.07356000' }] },
        { round: 415, timestamp: 1788124201, btc_block_height: 150437,
          pairs: [{ pair: 'BTC/USD', price: '78455.00000000' }] }
    ],
    validation_status: 'valid'
};

describe('PRICE detail render: validator batch rounds', function () {

    it('[REGRESSION] renders the COIN/FIAT pairs and prices the batch carries', function () {
        const out = renderPriceDetails(BATCH);
        expect(out.roundsHidden).to.equal(false);
        expect(out.rounds).to.contain('BTC');
        expect(out.rounds).to.contain('USD');
        expect(out.rounds).to.contain('78600.74000000');
        expect(out.rounds).to.contain('DOGE');
        expect(out.rounds).to.contain('EUR');
        expect(out.rounds).to.contain('0.07356000');
    });

    it('names the round window and how many rounds it carries', function () {
        const out = renderPriceDetails(BATCH);
        expect(out.windowHidden).to.equal(false);
        expect(out.window).to.contain('414');
        expect(out.window).to.contain('415');
        expect(out.window).to.contain('2 rounds');
    });

    it('summarizes the batch by round and price count', function () {
        // 2 rounds carrying 2 + 1 pairs.
        const out = renderPriceDetails(BATCH);
        expect(out.summary).to.contain('2 rounds');
        expect(out.summary).to.contain('3 prices');
    });

    it('[REGRESSION] falls back to the signature set when sig_count is NULL', function () {
        // The batch's sigs_json covers the whole window, so a NULL sig_count is
        // not "no signatures" - it is "not stored per round". A dash here read as
        // an unsigned consensus action.
        const out = renderPriceDetails(BATCH);
        expect(out.sigCount).to.equal('2');
        expect(out.signersHidden).to.equal(false);
        expect(out.signers).to.contain('c1de91459e8bd93de9e');
    });

    it('[REGRESSION] reports pair width from the rounds when pair_count is NULL', function () {
        const out = renderPriceDetails(BATCH);
        expect(out.pairs).to.not.equal('-');
        expect(out.pairs).to.contain('2 per round');
    });

    it('links a round BTC anchor height into the BTC explorer for this network', function () {
        const out = renderPriceDetails({ ...BATCH, __xc: { status: { available: { TBTC: 'BTC (testnet)' } } } });
        // Anchored on Bitcoin whatever chain the action landed on, so TBTC, never the page coin.
        expect(out.roundsHtml).to.contain('/TBTC/block/150436');
        expect(out.roundsHtml).to.not.contain('/BTC/block/150436');
    });

    it('states an anchor height as plain text when this instance does not serve that BTC network', function () {
        // A DOGE-only deployment is a supported configuration; a link to a page it
        // has not got is worse than no link.
        const out = renderPriceDetails(BATCH);
        expect(out.roundsHtml).to.not.contain('/block/150436');
        expect(out.rounds).to.contain('150,436');
    });

    it('escapes a pair name and price, which are publisher-supplied on-chain values', function () {
        const out = renderPriceDetails({ ...BATCH, rounds: [
            { round: 1, timestamp: 1, btc_block_height: 2,
              pairs: [{ pair: '<img src=x onerror=alert(1)>/USD', price: '<script>alert(1)</script>' }] }
        ]});
        expect(out.roundsHtml).to.not.contain('<img src=x');
        expect(out.roundsHtml).to.not.contain('<script>');
        expect(out.roundsHtml).to.contain('&lt;img');
    });

    it('renders a round carrying no pairs without collapsing the table', function () {
        const out = renderPriceDetails({ ...BATCH, rounds: [{ round: 9, timestamp: 1, btc_block_height: 2, pairs: [] }] });
        expect(out.roundsHidden).to.equal(false);
        expect(out.roundsHtml).to.contain('colspan="3"');
        expect(out.summary).to.contain('0 prices');
    });

    it('hides the rounds block when the action carries none', function () {
        const out = renderPriceDetails({ ...BATCH, rounds: [], round_count: null, batch_first_round: null, batch_last_round: null });
        expect(out.roundsHidden).to.equal(true);
        expect(out.windowHidden).to.equal(true);
    });
});
