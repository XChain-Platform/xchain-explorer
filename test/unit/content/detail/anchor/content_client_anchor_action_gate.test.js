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
 * The ANCHOR card on the action page applies the same gates as the anchor page:
 * a row mined below ANCHOR_ACTIVATION, a v3 mined below ANCHOR_FOLD_ACTIVATION
 * and an unread version byte are labelled, not shown as a bundle. Drives the
 * SHIPPED showAnchorDetails against the SHIPPED #info-anchor markup, with the
 * activation tables lifted from the injected action.html.
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const { srcText } = require('../../../../helpers/source_text');
const { extractFn } = require('../../../../helpers/source_slice');
const { injectAnchorActivation } = require('../../../../../src/explorer/request/render_page.js');

const CONTENT = path.resolve(__dirname, '..', '..', '..', '../../src/content');
const read = (...parts) => fs.readFileSync(path.join(CONTENT, ...parts), 'utf8');
const RAW_HTML = read('html', 'action.html');
const PAGE_HTML = injectAnchorActivation(RAW_HTML);
const XCHAIN_SRC = srcText('src/content/js/xchain.js') + '\n' + read('js', 'formatters.js');
const STATE_SRC = read('js', 'anchor_detail_render', 'state.js');
const NETWORK_COIN_SRC = require('../../../../helpers/content-source.js').networkCoinSource();
const GLOBALS_START = PAGE_HTML.indexOf('var ANCHOR_ACTIVATION = ');
const GLOBALS_SRC = PAGE_HTML.slice(GLOBALS_START, PAGE_HTML.indexOf('</script>', GLOBALS_START));
const UNPARSED_STATUS = 'invalid: VERSION (unknown)';

function panelHtml() {
    const start = RAW_HTML.indexOf('<div class="d-none" id="info-anchor">');
    return RAW_HTML.slice(start, RAW_HTML.indexOf('id="info-price"', start));
}

function render(data, network) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(read('js', 'jquery.min.js'));
    dom.window.eval(read('js', 'numeral.js'));
    dom.window.XC = { coin: 'DOGE', network: network || 'testnet' };
    dom.window.eval(NETWORK_COIN_SRC);
    dom.window.eval(GLOBALS_SRC);
    dom.window.eval(STATE_SRC);
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(h, len){ return String(h == null ? '' : h).substring(0, len); }
        ${extractFn(XCHAIN_SRC, 'isNull', 'xchain.js')}
        ${extractFn(XCHAIN_SRC, 'escapeHtml', 'xchain.js')}
    `);
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatPriceAnchorHeight', 'xchain.js'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'showUndecodedAnchorPayload', 'xchain.js'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'showAnchorDetails', 'xchain.js'));
    dom.window.showAnchorDetails(data);
    const $ = dom.window.$;
    return {
        version: $('#info-anchor .anchor-version').text().trim(),
        sections: $('#info-anchor .anchor-sections').text().trim(),
        chain: $('#info-anchor .anchor-chain').text().trim(),
        blockHash: $('#info-anchor .anchor-block-hash').text().trim(),
        undecodedVisible: !$('#info-anchor .anchor-undecoded-row').hasClass('d-none'),
        globals: dom.window
    };
}

const TABLES = new Function(GLOBALS_SRC + '; return { activation: ANCHOR_ACTIVATION, fold: ANCHOR_FOLD_ACTIVATION };')();
const A = TABLES.activation.testnet;
const F = TABLES.fold['DOGE:testnet'];
const bundleRow = (version, height, chains, status) => ({
    action_index: 7, version, chain: 'TESTNET', network: 'testnet', block_index_doge: height,
    block_hash: 'aa'.repeat(32), ledger_hash: 'bb'.repeat(32),
    actions_hash: 'cc'.repeat(32), contract_hash: 'dd'.repeat(32),
    status: status || 'valid',
    sections: chains.map((chain, index) => ({ section_index: index, chain }))
});

describe('ANCHOR action detail: activation gates', function () {
    it('has numeric activation heights to test against', function () {
        expect(A).to.be.a('number');
        expect(F).to.be.a('number');
    });

    it('[TRAP] labels a v3 mined below the fold gate instead of counting a chain', function () {
        const r = render(bundleRow(3, F - 1, ['TESTNET'], UNPARSED_STATUS));
        expect(r.version).to.equal('v3 - v3 before fold activation');
        expect(r.sections).to.equal('-');
        expect(r.chain).to.equal('-');
        expect(r.blockHash).to.equal('-');
        expect(r.undecodedVisible).to.equal(true);
    });

    it('hides positional payload fields for an unknown stored version', function () {
        const r = render(bundleRow(4, F, ['TESTNET'], UNPARSED_STATUS));
        expect(r.version).to.equal('v4 - Unrecognized version v4');
        expect(r.chain).to.equal('-');
        expect(r.blockHash).to.equal('-');
        expect(r.undecodedVisible).to.equal(true);
    });

    it('shows a v3 at the fold gate as a bundle with its chain count', function () {
        const r = render(bundleRow(3, F, ['BTC', 'LTC']));
        expect(r.version).to.equal('v3');
        expect(r.sections).to.contain('2 chains');
        expect(r.chain).to.equal('TESTNET');
        expect(r.undecodedVisible).to.equal(false);
    });

    it('labels a v1 and a v0 below activation as legacy', function () {
        expect(render(bundleRow(1, A - 1, [])).version).to.equal('v1 - Legacy (before activation)');
        const v0 = render(bundleRow(0, A - 1, ['BTC']));
        expect(v0.version).to.equal('v0 - Legacy (before activation)');
        expect(v0.sections).to.equal('-');
    });
});

describe('ANCHOR action detail: activation gates', function () {
    it('lets the legacy label win over the pre-fold label for a v3 below activation', function () {
        expect(render(bundleRow(3, A - 1, ['BTC'])).version).to.equal('v3 - Legacy (before activation)');
    });

    it('shows a v0 at activation as a bundle with its chain count', function () {
        const r = render(bundleRow(0, A, ['BTC', 'LTC', 'DOGE']));
        expect(r.version).to.equal('v0');
        expect(r.sections).to.contain('3 chains');
    });

    it('treats a v3 on mainnet as pre-fold while the fold gate is unarmed', function () {
        const r = render(bundleRow(3, TABLES.activation.mainnet + 1, ['BTC']), 'mainnet');
        expect(r.version).to.equal('v3 - v3 before fold activation');
    });

    it('[TRAP] labels stored version 0 under the unknown-version status as an unread version', function () {
        const r = render(bundleRow(0, A, ['BTC'], UNPARSED_STATUS));
        expect(r.version).to.equal('Unrecognized version');
        expect(r.sections).to.equal('-');
    });

    it('keeps a real v0 under another invalid status as a one-chain bundle', function () {
        const r = render(bundleRow(0, A, ['BTC'], 'invalid: SIGNATURE'));
        expect(r.version).to.equal('v0');
        expect(r.sections).to.equal('1 chain');
        expect(r.chain).to.equal('TESTNET');
        expect(r.undecodedVisible).to.equal(false);
    });

    it('wires both activation tables and the shared traits script into action.html', function () {
        expect(RAW_HTML).to.contain('var ANCHOR_ACTIVATION = {ANCHOR_ACTIVATION};');
        expect(RAW_HTML).to.contain('var ANCHOR_FOLD_ACTIVATION = {ANCHOR_FOLD_ACTIVATION};');
        expect(RAW_HTML).to.contain('src="/js/anchor_detail_render/state.js"');
        expect(PAGE_HTML).to.not.contain('{ANCHOR_ACTIVATION}');
        expect(PAGE_HTML).to.not.contain('{ANCHOR_FOLD_ACTIVATION}');
    });
});
