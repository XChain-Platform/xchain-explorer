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
 * XCALL detail page lifecycle timeline (/{COIN}/xcall/{CALL_ID}).
 *
 * Drives the SHIPPED buildXcallTimeline / renderXcallTimeline
 * (src/content/js/xcall-timeline-render.js) and the SHIPPED inline loader in
 * src/content/html/xcall.html with stubbed /api/xcall responses, in the same
 * JSDOM-eval harness checkpoint-verify-render.test.js uses.
 *
 * What it protects: XCALL phase transitions are written WITHOUT an action row,
 * so nothing on any action feed carries them and the whole lifecycle is
 * inferred from one composed row whose `execution` and `callback_delivery`
 * sub-objects are null until they happen. "Null" therefore has to be read
 * against the request's terminal status, or an EXPIRED call - which never
 * executes on the far chain at all - renders as forever pending, i.e. exactly
 * like a healthy in-flight call. These cases pin that reading, the lifecycle
 * ORDER the phases render in, and the page's explicit not-found branch.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '../../src/content');
const XCHAIN_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/xchain.js'), 'utf8');
const RENDER_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/xcall-timeline-render.js'), 'utf8');
const PAGE_HTML   = fs.readFileSync(path.join(SRC_DIR, 'html/xcall.html'), 'utf8');
const JQUERY_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.join(SRC_DIR, 'js/numeral.js'), 'utf8');

function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// The page fragment's own inline loader (the LAST <script> block, the one with no
// src attribute), so the not-found and error branches are driven as shipped.
function inlineScript() {
    const open = PAGE_HTML.lastIndexOf('<script type="text/javascript">');
    if (open < 0) throw new Error('inline script block not found in xcall.html');
    const bodyStart = PAGE_HTML.indexOf('>', open) + 1;
    const end = PAGE_HTML.indexOf('</script>', bodyStart);
    if (end < 0) throw new Error('unterminated inline script in xcall.html');
    return PAGE_HTML.slice(bodyStart, end);
}

// The fragment's markup with its <script> tags removed; the scripts are eval'd
// by hand so the JSDOM never needs to fetch /js/*.
function pageMarkup() {
    return PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
}

function makeWindow() {
    const dom = new JSDOM('<!DOCTYPE html><body>' + pageMarkup() + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(NUMERAL_SRC);
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'escapeHtml'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatHash'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'formatLivestamp'));
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function updatePageInfo(){}
    `);
    dom.window.XC = { coin: 'BTC', name: 'Bitcoin', network: 'mainnet', query: CALL_ID, pageInfo: {} };
    dom.window.eval(RENDER_SRC);
    return dom.window;
}

// Drives the shipped derivation + render directly.
function timeline(data) {
    const w = makeWindow();
    const phases = w.buildXcallTimeline(data);
    w.$('#xcall-timeline').html(w.renderXcallTimeline(data));
    const $ = w.$;
    const states = {};
    $('#xcall-timeline .xcall-phase').each(function () {
        states[$(this).attr('data-phase')] = $(this).attr('data-state');
    });
    return {
        phases,
        order:    phases.map(p => p.key),
        state:    phases.reduce((a, p) => { a[p.key] = p.state; return a; }, {}),
        domOrder: $('#xcall-timeline .xcall-phase').map(function () { return $(this).attr('data-phase'); }).get(),
        domState: states,
        text:     $('#xcall-timeline').text(),
        html:     $('#xcall-timeline').html(),
        summary:  w.xcallLifecycleSummary(data),
        $
    };
}

// Drives the shipped page loader with a stubbed $.getJSON, so the not-found and
// transport-failure branches run exactly as they do in the browser.
function page(mode, payload) {
    const w = makeWindow();
    w.$.getJSON = function (url, cb) {
        w.__requestedUrl = url;
        if (mode === 'success') cb(payload);
        const handle = { fail: function (f) { if (mode === 'fail') f(payload); return handle; } };
        return handle;
    };
    // The fragment wraps its work in $(document).ready; the document is already
    // loaded here, so the callback runs on the next microtask.
    w.eval(inlineScript());
    return new Promise(resolve => setTimeout(() => resolve(w.$), 0));
}

const CALL_ID = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2';

// Shape and field names taken from getXcall (src/db.js:10905): the xcalls row plus
// the nested `execution` and `callback_delivery` sub-objects.
const BASE = {
    action: 'XCALL', action_index: 4001, action_format: 0, version: 0,
    call_id: CALL_ID, contract_index: 10, source: 'bcrt1qsource',
    target_chain: 'LTC', target_contract_index: 20, method: 'ping',
    params: ['a', 1], params_json: '["a",1]', gas_limit: 100000, cross_hops: 1,
    callback_method: 'pong', callback_params: [], callback_params_json: '[]',
    deadline_block: 900500, request_status: 'pending',
    result_status: null, result_payload: null, resolved_block: null,
    callback_action_index: null, block_index: 900000, timestamp: 1750000000,
    tx_hash: 'ff'.repeat(32), tx_index: 77, status: 'valid',
    execution: null, callback_delivery: null
};

const COMPLETED = {
    ...BASE,
    request_status: 'completed', result_status: 'ok', result_payload: 'pong-result',
    resolved_block: 900123, callback_action_index: 4055,
    execution: {
        execute_action_index: 555, result_status: 'ok',
        return_payload_b64: 'cG9uZy1yZXN1bHQ=', gas_used: 21000,
        execution_block_index: 900100
    },
    callback_delivery: { callback_result_status: 'ok', callback_block_index: 900123 }
};

// The expire path (xchain-indexer/src/actions/xcall.js:329) flips the request to
// expired/expired with an empty payload and synthesizes an 'expired' callback. No
// execution row is ever written: the far chain never ran it.
const EXPIRED = {
    ...BASE,
    request_status: 'expired', result_status: 'expired', result_payload: '',
    resolved_block: 900501, callback_action_index: 4090,
    execution: null,
    callback_delivery: { callback_result_status: 'expired', callback_block_index: 900501 }
};

describe('xcall.html lifecycle timeline @regression', function () {

    it('[order] renders every phase, in lifecycle order, whether or not it carries data', function () {
        const t = timeline(BASE);
        expect(t.order).to.deep.equal(['request', 'execution', 'callback', 'settlement', 'deadline']);
        expect(t.domOrder).to.deep.equal(['request', 'execution', 'callback', 'settlement', 'deadline']);
    });

    it('[completed] a fully delivered call shows every phase complete', function () {
        const t = timeline(COMPLETED);
        expect(t.domState).to.deep.equal({
            request: 'done', execution: 'done', callback: 'done',
            settlement: 'done', deadline: 'done'
        });
        expect(t.summary.text).to.equal('Completed');
        // The far-chain execution is minted on the TARGET chain, so its action link
        // must be namespaced by target_chain, not by the page coin.
        expect(t.html).to.contain('/LTC/action/555');
    });

    it('[expired] an expired call renders its expiry, and never as pending or blank', function () {
        const t = timeline(EXPIRED);
        // The load-bearing pair: the far-chain execution NEVER runs for an expiry, so
        // reading its null sub-object without the request status renders 'pending'
        // here and the page becomes indistinguishable from a healthy in-flight call.
        expect(t.domState.execution).to.equal('skipped');
        expect(t.domState.settlement).to.equal('expired');
        expect(t.domState.deadline).to.equal('expired');
        expect(t.domState.callback).to.equal('expired');
        expect(t.domState.request).to.equal('done');
        expect(Object.values(t.domState)).to.not.contain('pending');
        expect(t.summary.state).to.equal('expired');
        // The expiry block reaches the page rather than the state alone.
        expect(t.html).to.contain('/BTC/block/900501');
        expect(t.text).to.contain('expired');
    });

    it('[expired] the deadline phase reports the deadline block that was missed', function () {
        const t = timeline(EXPIRED);
        const dl = t.phases.find(p => p.key === 'deadline');
        expect(dl.block).to.equal(900500);
        expect(dl.state).to.equal('expired');
    });

    it('[late] a result delivered AFTER the deadline block is flagged, not flattened into success', function () {
        // The expiry sweep and the result delivery are both height-driven and race;
        // when delivery wins past the deadline the reader needs to see it.
        const t = timeline({ ...COMPLETED, resolved_block: 900777, deadline_block: 900500 });
        expect(t.domState.deadline).to.equal('late');
        expect(t.domState.settlement).to.equal('done');
    });

    it('[late] a result delivered ON the deadline block is not late', function () {
        const t = timeline({ ...COMPLETED, resolved_block: 900500, deadline_block: 900500 });
        expect(t.domState.deadline).to.equal('done');
    });

    it('[rejected] a reverted far-chain execution and a skipped callback are told apart from success', function () {
        const t = timeline({
            ...COMPLETED, result_status: 'reverted',
            execution: { ...COMPLETED.execution, result_status: 'reverted', return_payload_b64: '' },
            callback_delivery: { callback_result_status: 'skipped:expired', callback_block_index: 900123 }
        });
        expect(t.domState.execution).to.equal('failed');
        expect(t.domState.callback).to.equal('skipped');
        expect(t.domState.settlement).to.equal('failed');
        expect(t.summary.state).to.equal('failed');
    });

    it('[refused] a request consensus refused starts no lifecycle at all', function () {
        const t = timeline({ ...BASE, status: 'invalid: CALL_ID (does not match deterministic derivation)' });
        expect(t.domState.request).to.equal('failed');
        expect(t.domState.execution).to.equal('skipped');
        expect(t.domState.callback).to.equal('skipped');
        expect(t.domState.settlement).to.equal('skipped');
        expect(t.domState.deadline).to.equal('skipped');
    });

    it('[in flight] an unresolved call shows the unreached phases as pending, not missing', function () {
        const t = timeline(BASE);
        expect(t.domState).to.deep.equal({
            request: 'done', execution: 'pending', callback: 'pending',
            settlement: 'pending', deadline: 'pending'
        });
        expect(t.summary.text).to.equal('In flight');
    });

    it('[no callback] a call that requested no callback shows the phase as unused, not missing', function () {
        const t = timeline({ ...BASE, callback_method: null });
        expect(t.domState.callback).to.equal('none');
    });

    it('[completed, no mirror] a delivered result with no mirrored execution row reads as no-record', function () {
        const t = timeline({ ...COMPLETED, execution: null });
        expect(t.domState.execution).to.equal('missing');
    });

    it('[page] loads the singular API route and renders the timeline from a bare object', async function () {
        const $ = await page('success', COMPLETED);
        expect($('#xcall-timeline .xcall-phase').length).to.equal(5);
        expect($('#xcall-header').text()).to.contain(CALL_ID);
    });

    it('[page] accepts the {total,data} envelope shape as well as the bare object', async function () {
        const $ = await page('success', { total: 1, data: [COMPLETED] });
        expect($('#xcall-timeline .xcall-phase').length).to.equal(5);
    });

    it('[page] not found renders an explicit no-such-record message, not a placeholder page', async function () {
        const $ = await page('success', {});
        expect($('#xcall-header').text()).to.contain('No cross-chain call is recorded with this call ID.');
        expect($('#xcall-timeline .xcall-phase').length).to.equal(0);
        expect($('#xcall-header .text-danger').length, 'a missing record is not an error').to.equal(0);
    });

    it('[page] a 404 from getData surfaces the server error string in a danger row', async function () {
        const $ = await page('fail', { status: 404, responseJSON: { error: 'Cross-chain call not found', code: 'NOT_FOUND' } });
        expect($('#xcall-header .text-danger').text()).to.equal('Cross-chain call not found');
    });

    it('[page] a transport failure with no JSON body still says something', async function () {
        const $ = await page('fail', { status: 0 });
        expect($('#xcall-header .text-danger').text()).to.equal('Could not load this cross-chain call');
    });
});
