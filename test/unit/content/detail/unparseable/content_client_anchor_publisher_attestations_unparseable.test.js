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
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { srcText } = require('../../../../helpers/source_text');
const NETWORK_COIN_SRC = require('../../../../helpers/content-source.js').networkCoinSource();

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.join(ROOT, 'src/content/js/formatters.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/action.html'), 'utf8');

function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in client source: ' + name);
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
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-anchor">');
    if (start < 0) throw new Error('#info-anchor panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-price"', start);
    if (end < 0) throw new Error('could not bound the #info-anchor panel');
    return ACTION_HTML.slice(start, end);
}

function render(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'DOGE', network: 'mainnet' };
    dom.window.eval(NETWORK_COIN_SRC);
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(value, len){ return String(value).substring(0, len); }
        ${extractFn('isNull')}
        ${extractFn('escapeHtml')}
    `);
    dom.window.eval(extractFn('formatPriceAnchorHeight'));
    dom.window.eval(extractFn('showAnchorPublisherDetails'));
    dom.window.eval(extractFn('showAnchorDetails'));
    dom.window.showAnchorDetails(Object.assign({
        sections: [], version: 4, chain: 'BTC', network: 'mainnet',
        checkpoint_seq: null, snapshot_block: null, block_hash: null,
        ledger_hash: null, actions_hash: null, contract_hash: null,
        match_batch_seq: null, match_count: null, chunk_index: null,
        total_chunks: null, block_index_doge: null, state_root: null,
        block_merkle_root: null, publisher: null, publisher_attestations: []
    }, data));
    const $ = dom.window.$;
    const count = $('#info-anchor .anchor-publisher-attestation-count');
    const signers = $('#info-anchor .anchor-publisher-attestations');
    return {
        rowHidden: $('#info-anchor .anchor-publisher-row').hasClass('d-none'),
        countText: count.text().trim(),
        countDanger: count.hasClass('text-danger'),
        signersText: signers.text().trim(),
        signersHtml: signers.html(),
        signersDanger: signers.hasClass('text-danger')
    };
}

describe('ANCHOR publisher attestations client rendering', function () {
    it('shows malformed publisher attestations as an error', function () {
        const result = render({ publisher_attestations_unparseable: true });

        expect(result.rowHidden).to.equal(false);
        expect(result.countDanger).to.equal(true);
        expect(result.countText).to.match(/invalid/i);
        expect(result.signersDanger).to.equal(true);
        expect(result.signersText).to.match(/invalid/i);
    });

    it('keeps the populated count and signer list unchanged', function () {
        const result = render({
            publisher_attestations: [
                { pubkey: 'publisher-one', sig: 'signature-one' },
                { pubkey: 'publisher-two', sig: 'signature-two' }
            ]
        });

        expect(result.rowHidden).to.equal(false);
        expect(result.countText).to.equal('2');
        expect(result.signersHtml).to.equal('publisher-one<br>publisher-two');
        expect(result.countDanger).to.equal(false);
        expect(result.signersDanger).to.equal(false);
    });

    it('renders a legitimately empty tail as a dash without an error marker', function () {
        const result = render({ publisher: 'publisher-key' });

        expect(result.rowHidden).to.equal(false);
        expect(result.countText).to.equal('0');
        expect(result.signersText).to.equal('-');
        expect(result.countDanger).to.equal(false);
        expect(result.signersDanger).to.equal(false);
    });
});
