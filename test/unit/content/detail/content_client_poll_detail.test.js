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
 * VOTE poll detail page. Drives the SHIPPED renders in
 * src/content/js/poll_tally_render.js, and the SHIPPED inline script of
 * src/content/html/poll.html, against stubbed endpoint payloads, in the same
 * JSDOM harness the other content-client-*-detail tests use.
 *
 * What it protects:
 *
 *  - LIVE vs REVOKED DELEGATIONS. vote_delegations is an append-only log: a
 *    revoke appends a CLEAR row (no delegate). A page that lists rows without
 *    telling a CLEAR from a delegation shows a holder as still delegating their
 *    voting weight after they took it back, which is the single worst thing this
 *    surface can say. The regtest venue cannot produce that row through the API
 *    (getVoteDelegations filters CLEARs server-side), so nothing else in the
 *    suite exercises the client's side of the rule.
 *
 *  - OPEN vs CLOSED. An open poll's provisional standing must never render as a
 *    settled result, and a settled result must never render as still-collecting.
 *
 *  - TALLY BASIS. votes.share is a relative share, not weight; real weight only
 *    exists in poll_results after finalization. A finalized poll therefore
 *    tallies from poll_results and an open one shows a labelled ballot count.
 *
 *  - NOT FOUND is an explicit branch, not a page of blank placeholders.
 */

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/poll_tally_render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/poll.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8');

// Slice a top-level function out of the source by walking braces, so the test
// runs shipped code rather than a copy that can drift.
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

// Helpers the renders lean on, kept naive so anything the assertions observe is
// the render's own doing. isNull is the REAL one out of xchain.js: the
// live/revoked verdict is expressed through it, so a stub would test the stub.
function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = { coin: 'RBTC', query: '4242', name: 'Bitcoin', network: 'regtest', pageInfo: {}, datatables: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(t){ return 'a while ago'; }
        function updatePageInfo(){}
        function loadDatatablesData(){ window.__datatable = Array.prototype.slice.call(arguments); }
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(XCHAIN_SRC, 'isNull')}
    `);
    dom.window.eval(RENDER_SRC);
}

function renderDom() {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="out"></div></body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    return dom;
}

// Drop a render's HTML into the DOM exactly as poll.html hands it to .html().
function paint(dom, html) {
    dom.window.$('#out').html(html);
    return dom.window.$;
}

/* ------------------------------------------------------------------ *
 * Whole-page harness: evaluates poll.html's SHIPPED inline script with
 * $.getJSON answering from a stubbed route table.
 * ------------------------------------------------------------------ */
function loadPage(routes) {
    const bodyHtml = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("poll.html's inline ready block was not found");
    const inline = PAGE_HTML.slice(scriptStart, PAGE_HTML.lastIndexOf('</script>'));

    const dom = new JSDOM('<!DOCTYPE html><body>' + bodyHtml + '</body>', { runScripts: 'outside-only' });
    installHelpers(dom);

    // Run the ready callback synchronously so the assertions do not race
    // jQuery's deferred ready queue. Harness-only; the page is untouched.
    dom.window.eval('jQuery.fn.ready = function(fn){ fn(jQuery); return this; };');

    const seen = [];
    dom.window.$.getJSON = function (url, cb) {
        seen.push(url);
        const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
        let xhr = null;
        if (r === undefined) {
            xhr = { status: 404, responseJSON: { error: 'poll not found', code: 'NOT_FOUND' } };
        } else if (r && r.__fail) {
            xhr = r.__fail;
        } else {
            cb(r);
        }
        return { fail: function (f) { if (xhr) f(xhr); return this; } };
    };

    dom.window.eval(inline);
    return { $: dom.window.$, seen, window: dom.window };
}

/* ------------------------------- fixtures ------------------------------- */

const OPEN_POLL = {
    action_index: 4242, action: 'vote', source: 'mSourceAddr', tick: 'GOVMT0XGKFM1', tick_id: 166,
    end_block: 900, options: ['Ship it', 'Hold'], max_selections: 1, tally_mode: 'approval',
    weight_mode: 'balance', quorum: '0.25', min_voters: 3, min_vote_balance: '1',
    decide_threshold: null, question: 'Should the treasury fund the audit?',
    poll_status: 'open', winning_option: null, total_weight: null, total_voters: null,
    quorum_met: null, min_voters_met: null, fail_reason: null, decided_early: null,
    effective_close_block: null, finalized_action_index: null, resolved_block: null,
    deposit_amount: null, deposit_address: null, deposit_resolved: null,
    callback_contract_index: null, callback_method: null, callback_params: null,
    callback_on: null, gas_escrow: null, callback_delay_blocks: null,
    callback_execute_action_index: null, block_index: 800, timestamp: 1700000000,
    tx_hash: 'aa', tx_index: 1, status: 1
};

const CLOSED_POLL = Object.assign({}, OPEN_POLL, {
    poll_status: 'passed', winning_option: 1, total_weight: '1200', total_voters: 4,
    quorum_met: 1, min_voters_met: 1, fail_reason: null, decided_early: 1,
    effective_close_block: 880, finalized_action_index: 4999, resolved_block: 881
});

// poll_results: the FROZEN per-option tally, only written at finalization.
const CLOSED_RESULTS = [
    { poll_index: 4242, option_index: 0, total_weight: '300',  voter_count: 1, finalize_action_index: 4999, block_index: 881, status: 1 },
    { poll_index: 4242, option_index: 1, total_weight: '900',  voter_count: 3, finalize_action_index: 4999, block_index: 881, status: 1 }
];

// Ballots, append-only: mVoterA re-voted (5002 supersedes 5000, moving off
// option 0), so a raw count would credit option 0 with a vote nobody holds.
const OPEN_VOTES = [
    { action_index: 5000, source: 'mVoterA', poll_index: 4242, choice: 0, share: '1', block_index: 810, status: 1 },
    { action_index: 5001, source: 'mVoterB', poll_index: 4242, choice: 1, share: '1', block_index: 811, status: 1 },
    { action_index: 5002, source: 'mVoterA', poll_index: 4242, choice: 1, share: '1', block_index: 815, status: 1 }
];

// Delegations on the electorate tick. mDlgtC's latest row is a CLEAR (a revoke),
// which carries no delegate and must never render as a live delegation.
const DELEGATIONS = [
    { action_index: 6001, tick: 'GOVMT0XGKFM1', delegator: 'mDlgtA', delegate: 'mRepX', block_index: 700, timestamp: 1, tx_hash: 'b', status: 1 },
    { action_index: 6003, tick: 'GOVMT0XGKFM1', delegator: 'mDlgtB', delegate: 'mRepY', block_index: 702, timestamp: 1, tx_hash: 'c', status: 1 },
    { action_index: 6004, tick: 'GOVMT0XGKFM1', delegator: 'mDlgtC', delegate: null,    block_index: 703, timestamp: 1, tx_hash: 'd', status: 1 }
];

/* -------------------------------- tests -------------------------------- */

const POLL_URL   = '/RBTC/api/poll/4242';
const RESULT_URL = '/RBTC/api/poll/4242/results';
const VOTES_URL  = '/RBTC/api/votes/4242/poll';
const DLG_URL    = '/RBTC/api/vote_delegations/GOVMT0XGKFM1/tick';

module.exports = { expect, renderDom, paint, loadPage, OPEN_POLL, CLOSED_POLL, CLOSED_RESULTS, OPEN_VOTES, DELEGATIONS, POLL_URL, RESULT_URL, VOTES_URL, DLG_URL };

require('./content_client_poll_detail.test/support/delegations.js');
require('./content_client_poll_detail.test/support/lifecycle.js');
require('./content_client_poll_detail.test/support/tally.js');
require('./content_client_poll_detail.test/support/quorum.js');
require('./content_client_poll_detail.test/support/page_wiring_render.js');
require('./content_client_poll_detail.test/support/page_wiring_errors.js');
require('./content_client_poll_detail.test/support/escaping.js');
