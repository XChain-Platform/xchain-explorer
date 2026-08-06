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
 * XCALL detail render leg. Drives the SHIPPED showXcallDetails against the
 * SHIPPED #info-xcall markup, in the same harness the LIST and PRICE render
 * tests use.
 *
 * What it protects: the XCALL detail query selects xcalls.result_status,
 * result_payload and resolved_block (src/action-detail/crosschain.js), and those
 * three columns are the record the VM's xchain.crossChain.getCallResult reads,
 * so they are what a contract on this chain sees as the call's outcome. The page
 * rendered only the mirrored far-chain execution row and the callback row, so
 * the recorded result was fetched on every view and never shown, and nothing
 * exercised whether the two records still agreed.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
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
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-xcall">');
    if (start < 0) throw new Error('#info-xcall panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-xexec"', start);
    if (end < 0) throw new Error('could not bound the #info-xcall panel');
    return ACTION_HTML.slice(start, end);
}

function renderXcallDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));

    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(v, len){ return v == null ? '-' : String(v).substring(0, len || 32); }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showXcallDetails'));
    dom.window.showXcallDetails(data);
    const $ = dom.window.$;
    const cell = (cls) => $('#info-xcall .' + cls).text().trim();
    return {
        recordedShown:   !$('#info-xcall .xcall-resolved-row').first().hasClass('d-none'),
        recordedStatus:  cell('xcall-recorded-status'),
        recordedPayload: cell('xcall-recorded-payload'),
        resolvedBlock:   cell('xcall-resolved-block'),
        executionShown:  !$('#info-xcall .xcall-execution-row').first().hasClass('d-none'),
        execStatus:      cell('xcall-result-status')
    };
}

const BASE = {
    call_id: 'abcd1234', version: 0, contract_index: 10, target_chain: 'LTC',
    target_contract_index: 20, method: 'ping', params: [], gas_limit: 100000,
    cross_hops: 1, callback_method: 'pong', deadline_block: 900000,
    request_status: 'pending', result_status: null, result_payload: null,
    resolved_block: null, callback_action_index: null, execution: null,
    callback_delivery: null
};

describe('XCALL detail render: the recorded result reaches the page', function () {

    it('[REGRESSION] renders result_status, result_payload and resolved_block once the request resolves', function () {
        const out = renderXcallDetails({
            ...BASE, request_status: 'completed', result_status: 'ok',
            result_payload: 'deadbeefcafe', resolved_block: 899123
        });
        expect(out.recordedShown, 'the recorded-result group is revealed').to.equal(true);
        expect(out.recordedStatus).to.equal('ok');
        expect(out.recordedPayload).to.equal('deadbeefcafe');
        expect(out.resolvedBlock).to.equal('899,123');
    });

    it('hides the recorded-result group while the request is still pending', function () {
        const out = renderXcallDetails(BASE);
        expect(out.recordedShown, 'nothing recorded yet, so nothing to show').to.equal(false);
    });

    it('shows the recorded result for an expired request, which never executes on the far chain', function () {
        // The expire path writes result_status expired with no execution row, so
        // this is the case where the recorded record is the ONLY outcome the page
        // can show; before this it showed none.
        const out = renderXcallDetails({
            ...BASE, request_status: 'expired', result_status: 'expired',
            result_payload: '', resolved_block: 899500
        });
        expect(out.recordedShown).to.equal(true);
        expect(out.recordedStatus).to.equal('expired');
        expect(out.executionShown, 'no far-chain execution for an expire').to.equal(false);
    });

    it('keeps the recorded record distinct from the mirrored execution record', function () {
        // Two different sources: xcalls (this chain, what getCallResult reads) and
        // cross_chain_call_executions (mirrored back from the target chain). A
        // divergence between them is exactly what a reader needs to be able to see.
        const out = renderXcallDetails({
            ...BASE, request_status: 'completed', result_status: 'ok',
            result_payload: 'aa', resolved_block: 899123,
            execution: { execute_action_index: 555, result_status: 'reverted', return_payload_b64: 'bb', gas_used: 21000 }
        });
        expect(out.recordedStatus).to.equal('ok');
        expect(out.execStatus).to.equal('reverted');
    });
});
