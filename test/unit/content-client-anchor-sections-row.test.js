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
 * ANCHOR action-detail elision label. Drives the SHIPPED showAnchorDetails
 * against the SHIPPED #info-anchor markup sliced out of action.html.
 *
 * What it protects: a v0 ANCHOR bundles every checkpointed chain into ONE
 * action, stored as N sibling anchor_actions rows. The action page renders the
 * SPINE row, so its chain / checkpoint_seq / hashes belong to section 0 alone.
 * Without a section count on the page, every other chain is elided with nothing
 * saying it happened, and a reader takes section 0's checkpoint for the anchor's.
 * The per-chain table itself has one renderer, on the anchor page; this row says
 * how many chains there are and links to it.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

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
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-anchor">');
    if (start < 0) throw new Error('#info-anchor panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-price"', start);
    if (end < 0) throw new Error('could not bound the #info-anchor panel');
    return ACTION_HTML.slice(start, end);
}

function render(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'DOGE', network: 'mainnet' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(h, len){ return String(h == null ? '' : h).substring(0, len); }
        ${extractFn('isNull')}
        ${extractFn('escapeHtml')}
    `);
    dom.window.eval(extractFn('showAnchorDetails'));
    dom.window.showAnchorDetails(data);
    const $ = dom.window.$;
    return {
        sections:     $('#info-anchor .anchor-sections').text().trim(),
        sectionsHtml: $('#info-anchor .anchor-sections').html(),
        chain:        $('#info-anchor .anchor-chain').text().trim()
    };
}

const BUNDLE = {
    action_index: 9911, version: 0, chain: 'BTC', network: 'mainnet',
    checkpoint_seq: 11, snapshot_block: 910000, block_hash: 'aa', ledger_hash: 'dd',
    actions_hash: 'ee', contract_hash: 'ff', match_batch_seq: null, match_count: null,
    chunk_index: null, total_chunks: null, block_index_doge: 77,
    state_root: null, block_merkle_root: null, publisher: null, publisher_attestations: [],
    section_count: 3,
    sections: [
        { section_index: 0, chain: 'BTC' },
        { section_index: 1, chain: 'LTC' },
        { section_index: 2, chain: 'DOGE' }
    ]
};

const SINGLE = Object.assign({}, BUNDLE, { version: 1, section_count: 1, sections: [] });

describe('ANCHOR action detail: section count and elision label', function () {

    it('names every chain the bundle commits, not just the spine chain', function () {
        const r = render(BUNDLE);
        expect(r.sections).to.contain('3 chains');
        expect(r.sections).to.contain('BTC');
        expect(r.sections).to.contain('LTC');
        expect(r.sections).to.contain('DOGE');
        expect(r.chain).to.equal('BTC');
    });

    it('says the fields below are section 0 rather than the whole anchor', function () {
        expect(render(BUNDLE).sections).to.contain('section 0');
    });

    it('links the full per-chain view on the anchor page', function () {
        expect(render(BUNDLE).sectionsHtml).to.contain('/DOGE/anchor/9911');
    });

    it('claims no bundle structure for a single-section anchor', function () {
        const r = render(SINGLE);
        expect(r.sections).to.not.contain('section 0');
        expect(r.sections).to.not.contain('chains');
    });

    it('escapes a hostile chain name rather than injecting it', function () {
        const hostile = Object.assign({}, BUNDLE, {
            sections: [{ section_index: 0, chain: '<img src=x onerror=alert(1)>' },
                       { section_index: 1, chain: 'LTC' }]
        });
        const r = render(hostile);
        expect(r.sectionsHtml).to.not.contain('<img src=x');
        expect(r.sectionsHtml).to.contain('&lt;img');
    });
});
