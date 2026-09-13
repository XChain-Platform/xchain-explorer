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
 * ATTEST batch detail render leg. Drives the SHIPPED showAttestDetails against
 * the SHIPPED #info-attest markup sliced out of action.html, in the same harness
 * content-client-price-detail.test.js uses.
 *
 * What it protects: the `attests` table holds four row shapes keyed by version.
 * v5 (batch head) and v6 (batch continuation) carry the signed window header and
 * one chunk slot each, with every v0/v1 request and response column NULL, a batch
 * key in request_id and an empty provider_id. A renderer that branches only on
 * v1 and v2 badges a v5 as a plain "Request" and shows the request sub-panel, so
 * a signed batch window reads as a table of dashes and the window header, the
 * chunk slot and the body CRC never reach the page at all. Query-selects-it /
 * renderer-never-reads-it is a silent failure by construction.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

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
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-attest">');
    if (start < 0) throw new Error('#info-attest panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-vote"', start);
    if (end < 0) throw new Error('could not bound the #info-attest panel');
    return ACTION_HTML.slice(start, end);
}

function render(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/moment.min.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', network: 'testnet' };
    dom.window.eval(`
        function formatLink(href, text, label){ return '<a href="' + href + '">' + (label !== undefined ? label : text) + '</a>'; }
        function formatHash(h, len){ return String(h == null ? '' : h).substring(0, len); }
        function formatLivestamp(ts){ return '<span data-livestamp=' + ts + '></span>'; }
        function formatAmount(a){ return String(a); }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showAttestDetails'));
    dom.window.showAttestDetails(data);
    const $ = dom.window.$;
    const cell = (cls) => $('#info-attest .' + cls).text().trim();
    return {
        type:          cell('attest-type'),
        provider:      cell('attest-provider'),
        requestId:     cell('attest-request-id'),
        window:        cell('attest-batch-window'),
        windowHtml:    $('#info-attest .attest-batch-window').html(),
        rows:          cell('attest-batch-rows'),
        btcHeight:     cell('attest-batch-btc-height'),
        crc32:         cell('attest-batch-crc32'),
        chunk:         cell('attest-batch-chunk'),
        batchHidden:   $('#info-attest .attest-batch-fields').hasClass('d-none'),
        requestHidden: $('#info-attest .attest-request-fields').hasClass('d-none'),
        responseHidden:$('#info-attest .attest-response-fields').hasClass('d-none')
    };
}

// A v5 head as the detail query returns it: batch key in request_id, empty
// provider_id, every v0/v1 column NULL, window header and slot 0 populated.
const HEAD = {
    version: 5, request_id: 'bb'.repeat(32), provider_id: '', contract_index: null,
    batch_window_start: 1756000000, batch_window_end: 1756003600,
    batch_row_count: 42, batch_btc_block_height: 910000,
    batch_crc32: 'deadbeef', batch_total_chunks: 3, batch_chunk_index: 0
};

// A v6 continuation: the window header is declared on the head only, so those
// columns come back NULL here while crc32 and the chunk counters ride along.
const CONTINUATION = {
    version: 6, request_id: 'bb'.repeat(32), provider_id: '', contract_index: null,
    batch_window_start: null, batch_window_end: null,
    batch_row_count: null, batch_btc_block_height: null,
    batch_crc32: 'deadbeef', batch_total_chunks: 3, batch_chunk_index: 1
};

describe('ATTEST batch (v5 head / v6 continuation) detail render', function () {

    it('badges a v5 as a batch head rather than a request', function () {
        const r = render(HEAD);
        expect(r.type).to.equal('Batch Head (v5)');
    });

    it('shows the batch panel and hides the request and response panels on a v5', function () {
        const r = render(HEAD);
        expect(r.batchHidden).to.equal(false);
        expect(r.requestHidden).to.equal(true);
        expect(r.responseHidden).to.equal(true);
    });

    it('renders the v5 window header, row count, BTC height and CRC32', function () {
        const r = render(HEAD);
        expect(r.windowHtml).to.contain('1756000000');
        expect(r.windowHtml).to.contain('1756003600');
        expect(r.rows).to.equal('42');
        expect(r.btcHeight).to.equal('910,000');
        expect(r.crc32).to.equal('deadbeef');
    });

    // batch_chunk_index is 0 on the head and 1-based on each continuation, so the
    // reader-facing slot is index+1 of total on both.
    it('renders the head as chunk 1 of N', function () {
        expect(render(HEAD).chunk).to.equal('1 of 3');
    });

    it('renders a v6 continuation as its own later slot', function () {
        const r = render(CONTINUATION);
        expect(r.type).to.equal('Batch Continuation (v6)');
        expect(r.chunk).to.equal('2 of 3');
        expect(r.crc32).to.equal('deadbeef');
    });

    it('renders the absent window header on a v6 as a dash, not blank', function () {
        const r = render(CONTINUATION);
        expect(r.window).to.equal('-');
        expect(r.rows).to.equal('-');
        expect(r.btcHeight).to.equal('-');
    });

    it('renders the empty provider_id of a batch row as a dash', function () {
        expect(render(HEAD).provider).to.equal('-');
    });

    it('leaves the v0 request and v1 response branches untouched', function () {
        const req = render({ version: 0, request_id: 'aa'.repeat(32), provider_id: 'prov-1',
            fee_payer: null, fee_amount: null, gas_escrow: null, callback_method: 'cb',
            redundancy: 3, deadline_block: null, request_status: 'pending', payload: null,
            callback_params_json: null });
        expect(req.type).to.equal('Request (v0)');
        expect(req.requestHidden).to.equal(false);
        expect(req.batchHidden).to.equal(true);

        const resp = render({ version: 1, request_id: 'aa'.repeat(32), provider_id: 'prov-1',
            response_status: 'ok', response_hash: 'cc'.repeat(32), response_payload: 'body',
            meta: null, signatures: [], callback_execute_action_index: null });
        expect(resp.type).to.equal('Response (v1)');
        expect(resp.responseHidden).to.equal(false);
        expect(resp.batchHidden).to.equal(true);
    });
});
