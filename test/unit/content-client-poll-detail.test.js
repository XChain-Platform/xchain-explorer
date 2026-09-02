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
 * src/content/js/poll-tally-render.js, and the SHIPPED inline script of
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

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/poll-tally-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/poll.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');

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

describe('poll.html detail page @regression', function () {

    describe('delegations: live vs revoked', function () {

        it('[revoked] a CLEAR row is never listed or counted as a live delegation', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations(DELEGATIONS, 'GOVMT0XGKFM1'));

            const live = $('.poll-delegation-live');
            expect(live.length, 'only the two non-cleared delegations are live').to.equal(2);

            const liveDelegators = live.find('.poll-delegation-delegator').map(function () {
                return $(this).text().trim();
            }).get();
            expect(liveDelegators).to.deep.equal(['mDlgtA', 'mDlgtB']);
            expect(liveDelegators, 'the revoked delegator must not appear as live').to.not.include('mDlgtC');

            expect($('#poll-delegation-live-count').text().trim()).to.equal('2');
        });

        it('[revoked] the cleared row renders in the revoked state with no delegate', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations(DELEGATIONS, 'GOVMT0XGKFM1'));

            const revoked = $('.poll-delegation-revoked');
            expect(revoked.length).to.equal(1);
            expect(revoked.find('.poll-delegation-delegator').text().trim()).to.equal('mDlgtC');
            expect(revoked.find('.poll-delegation-delegate').text().trim()).to.equal('none');
            expect(revoked.find('.poll-delegation-delegate a').length, 'a revoked row links no delegate').to.equal(0);
            expect($('#poll-delegation-revoked-count').text().trim()).to.equal('1');
        });

        it('[live] a delegation with a delegate links both addresses', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations([DELEGATIONS[0]], 'GOVMT0XGKFM1'));
            expect($('.poll-delegation-live .poll-delegation-delegate a').attr('href'))
                .to.equal('/RBTC/address/mRepX');
            expect($('#poll-delegation-live-count').text().trim()).to.equal('1');
        });

        it('[empty] no delegations renders the empty state, not a table', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations([], 'GOVMT0XGKFM1'));
            expect($('#poll-delegation-empty').length).to.equal(1);
            expect($('#poll-delegation-table').length).to.equal(0);
            expect($('#poll-delegation-live-count').text().trim()).to.equal('0');
        });
    });

    describe('open vs closed', function () {

        it('[open] an open poll reads as still accepting ballots, with no result', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(OPEN_POLL));
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(true);
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(false);
            expect($('#poll-winning-option').length, 'an open poll has no winning option').to.equal(0);
            expect($('#poll-outcome-state').text()).to.contain('Open');
        });

        it('[closed] a closed poll reads as a result, naming the winning option label', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(CLOSED_POLL));
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(true);
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(false);
            expect($('#poll-winning-option').text().trim()).to.equal('Hold');
            expect($('#poll-outcome-state').text()).to.contain('decided early');
        });

        it('[closed] a poll that failed shows the fail reason', function () {
            const dom = renderDom();
            const failed = Object.assign({}, CLOSED_POLL, {
                poll_status: 'failed', winning_option: null, fail_reason: 'quorum'
            });
            const $ = paint(dom, dom.window.renderPollOutcome(failed));
            expect($('#poll-fail-reason').text()).to.contain('quorum');
            expect($('#poll-winning-option').length).to.equal(0);
        });

        it('[status] an unknown lifecycle state never renders as open', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(Object.assign({}, OPEN_POLL, { poll_status: null })));
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(false);
        });
    });

    describe('tally', function () {

        it('[closed] tallies from poll_results and badges the winning option', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(CLOSED_POLL, CLOSED_RESULTS, []));
            expect($('#poll-tally-metric').text().trim()).to.equal('Weight');
            const weights = $('.poll-tally-weight').map(function () { return $(this).text().trim(); }).get();
            expect(weights).to.deep.equal(['300', '900']);
            const winner = $('.poll-tally-winner');
            expect(winner.length).to.equal(1);
            expect(winner.text()).to.contain('Hold');
            expect($('#poll-tally-basis').text()).to.contain('Final tally');
        });

        it('[open] shows a provisional BALLOT count, never a weight', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], OPEN_VOTES));
            expect($('#poll-tally-metric').text().trim()).to.equal('Ballots');
            expect($('.poll-tally-weight').length, 'no weight column on an unfinalized poll').to.equal(0);
            expect($('#poll-tally-basis').text()).to.contain('not voting weight');
            expect($('.poll-tally-winner').length, 'an open poll has no winner').to.equal(0);
        });

        it('[open] a superseded re-vote is not counted against the option it moved off', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], OPEN_VOTES));
            const counts = $('.poll-tally-ballots').map(function () { return $(this).text().trim(); }).get();
            // mVoterA moved from option 0 to option 1, so option 0 holds nothing.
            expect(counts).to.deep.equal(['0', '2']);
        });

        it('[open] no ballots at all still renders every option', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], []));
            expect($('.poll-tally-row').length).to.equal(2);
            expect($('.poll-tally-ballots').map(function () { return $(this).text().trim(); }).get())
                .to.deep.equal(['0', '0']);
        });
    });

    describe('quorum gates', function () {

        it('[open] an unmeasured gate reads as not-yet-measured, never as failed', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollQuorum(OPEN_POLL));
            expect($('#poll-quorum-table').text()).to.contain('not yet measured');
            expect($('#poll-quorum-table').text()).to.not.contain('not met');
        });

        it('[closed] a measured gate reads met/not met', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollQuorum(
                Object.assign({}, CLOSED_POLL, { quorum_met: 0, min_voters_met: 1 })));
            const text = $('#poll-quorum-table').text();
            expect(text).to.contain('not met');
            expect(text).to.contain('met');
            expect(text).to.not.contain('not yet measured');
        });
    });

    describe('page wiring', function () {

        const POLL_URL   = '/RBTC/api/poll/4242';
        const RESULT_URL = '/RBTC/api/poll/4242/results';
        const VOTES_URL  = '/RBTC/api/votes/4242/poll';
        const DLG_URL    = '/RBTC/api/vote_delegations/GOVMT0XGKFM1/tick';

        it('[open] renders a bare-object poll response end to end', function () {
            const { $ } = loadPage({
                [POLL_URL]:   OPEN_POLL,
                [RESULT_URL]: { total: 0, data: [] },
                [VOTES_URL]:  { total: OPEN_VOTES.length, data: OPEN_VOTES },
                [DLG_URL]:    { total: DELEGATIONS.length, data: DELEGATIONS }
            });
            expect($('#poll-question').text()).to.contain('Should the treasury fund the audit?');
            expect($('#poll-status-value').text().trim()).to.equal('open');
            expect($('#poll-tick').text()).to.contain('GOVMT0XGKFM1');
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(true);
            expect($('#poll-tally-metric').text().trim()).to.equal('Ballots');
            expect($('.poll-delegation-live').length).to.equal(2);
            expect($('.poll-delegation-revoked').length).to.equal(1);
        });

        it('[closed] a finalized poll renders its frozen results', function () {
            const { $ } = loadPage({
                [POLL_URL]:   { total: 1, data: [CLOSED_POLL] },
                [RESULT_URL]: { total: 2, data: CLOSED_RESULTS },
                [DLG_URL]:    { total: 0, data: [] }
            });
            expect($('#poll-status-value').text().trim()).to.equal('passed');
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(true);
            expect($('#poll-tally-metric').text().trim()).to.equal('Weight');
            expect($('.poll-tally-winner').text()).to.contain('Hold');
        });

        it('[ballots] wires the votes datatable to the registered poll feed', function () {
            const { window } = loadPage({
                [POLL_URL]:   OPEN_POLL,
                [RESULT_URL]: { total: 0, data: [] },
                [VOTES_URL]:  { total: 0, data: [] },
                [DLG_URL]:    { total: 0, data: [] }
            });
            expect(window.__datatable).to.deep.equal(['RBTC', 'vote', '4242', 'poll']);
        });

        it('[not found] an empty response is an explicit not-found, not a blank page', function () {
            const { $ } = loadPage({ [POLL_URL]: { total: 0, data: [] } });
            expect($('#poll-not-found').length).to.equal(1);
            expect($('#poll-not-found').text()).to.contain('No poll exists at this id');
            expect($('#poll-tally').text().trim()).to.equal('-');
        });

        it('[404] the error branch surfaces the API error string in text-danger', function () {
            const { $ } = loadPage({
                [POLL_URL]: { __fail: { status: 404, responseJSON: { error: 'poll not found', code: 'NOT_FOUND' } } }
            });
            expect($('#poll-load-error').length).to.equal(1);
            expect($('#poll-load-error').hasClass('text-danger')).to.equal(true);
            expect($('#poll-load-error').text()).to.equal('poll not found');
        });
    });

    describe('escaping', function () {

        it('an attacker-controlled option label never reaches the DOM as markup', function () {
            const dom = renderDom();
            const evil = Object.assign({}, OPEN_POLL, { options: ['<img src=x onerror=alert(1)>', 'ok'] });
            const $ = paint(dom, dom.window.renderPollTally(evil, [], []));
            expect($('#poll-tally-table img').length).to.equal(0);
            expect($('.poll-tally-row').first().text()).to.contain('<img src=x onerror=alert(1)>');
        });
    });
});
