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
 **********************************************************************
 * Unified governance view (spec explorer-coverage-completion row 34, M5.3).
 * Drives the SHIPPED renders in src/content/js/governance-overview-render.js
 * and the SHIPPED inline script of src/content/html/governance.html.
 *
 * The row's whole substance is a design decision, and these are the assertions
 * that hold it:
 *
 *  1. THE TWO SYSTEMS ARE NOT MERGED. Token polls (on-chain VOTE, decided by
 *     token holders) and network-parameter proposals (hub-side, decided by the
 *     staked validator set) are deliberately distinct. They render as two
 *     tables with their own status vocabularies and no combined feed or tally.
 *     A merged tally would be a fabricated number: the two weigh different
 *     things.
 *
 *  2. THE TWO HALVES FAIL INDEPENDENTLY. The proposals half rides the hub dual
 *     path, which fails LOUD when a configured hub is unreachable past the
 *     stale ceiling. A hub outage must not blank the on-chain half, and must
 *     not render as "no proposals": that would tell a reader the federation is
 *     proposing nothing, which the page cannot know.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/governance-overview-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/governance.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');

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

function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = { coin: 'RDOGE', network: 'regtest', name: 'Dogecoin', pageInfo: {}, datatables: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function updatePageInfo(){}
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

function paint(dom, html) {
    dom.window.$('#out').html(html);
    return dom.window.$;
}

function loadPage(routes) {
    const bodyHtml = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("governance.html's inline ready block was not found");
    const inline = PAGE_HTML.slice(scriptStart, PAGE_HTML.lastIndexOf('</script>'));

    const dom = new JSDOM('<!DOCTYPE html><body>' + bodyHtml + '</body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    dom.window.eval('jQuery.fn.ready = function(fn){ fn(jQuery); return this; };');

    const seen = [];
    dom.window.$.getJSON = function (url, cb) {
        seen.push(url);
        const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
        let xhr = null;
        if (r === undefined) {
            xhr = { status: 404, responseJSON: { error: 'not found', code: 'NOT_FOUND' } };
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

const POLLS = [
    { action_index: 1024, tick: 'GOVMT1PBOT81', question: 'Fund the audit?', poll_status: 'open',   end_block: 2600 },
    { action_index: 1028, tick: 'GOVMT1PBOT81', question: 'Ship v2?',        poll_status: 'passed', end_block: 2400 }
];

const PROPOSALS = [
    { proposal_id: 'p-17', proposer_pubkey: 'a'.repeat(64), parameter: 'min_stake',
      current_value: '1000', proposed_value: '2500', status: 'voting', voting_end: 2700, activation_block: null }
];

const POLLS_URL     = '/RDOGE/api/polls?limit=25';
const PROPOSALS_URL = '/RDOGE/api/governance_proposals?limit=25';

describe('unified governance view (M5.3)', function () {

    describe('the two systems stay separate', function () {

        it('renders token polls in their own table with the indexer status verbatim', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderGovernancePolls(POLLS));
            expect($('.gov-poll-row').length).to.equal(2);
            expect($('.gov-poll-row').first().find('.gov-poll-status').text()).to.equal('open');
        });

        it('renders parameter proposals in their own table with the hub status verbatim', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderGovernanceProposals(PROPOSALS));
            expect($('.gov-proposal-row').length).to.equal(1);
            expect($('.gov-proposal-row').find('.gov-proposal-status').text()).to.equal('voting');
        });

        it('shows a proposal as a change FROM a value TO a value, never the new one alone', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderGovernanceProposals(PROPOSALS));
            const text = $('.gov-proposal-change').text();
            expect(text).to.include('1000');
            expect(text).to.include('2500');
        });

        it('renders NO combined tally or shared status vocabulary', function () {
            // The merge this row exists to refuse. Two systems that weigh
            // different things cannot share a number.
            const { $ } = loadPage({ [POLLS_URL]: { total: 2, data: POLLS }, [PROPOSALS_URL]: { total: 1, data: PROPOSALS } });
            expect($('.gov-polls-table').length).to.equal(1);
            expect($('.gov-proposals-table').length).to.equal(1);
            // No row from one system appears inside the other's table.
            expect($('.gov-polls-table .gov-proposal-row').length).to.equal(0);
            expect($('.gov-proposals-table .gov-poll-row').length).to.equal(0);
        });

        it('names each electorate on the page, so a reader is not left to infer them', function () {
            const { $ } = loadPage({ [POLLS_URL]: { data: POLLS }, [PROPOSALS_URL]: { data: PROPOSALS } });
            // Whitespace-normalized: the copy wraps in the fragment, and an
            // assertion pinned to its line breaks would fail on a reflow that
            // changed nothing a reader sees.
            const explainer = $('#governance-explainer').text().replace(/\s+/g, ' ');
            expect(explainer).to.include("that token's holders, weighted by balance");
            expect(explainer).to.include('the staked validator set');
        });

        it('escapes a hostile poll question instead of executing it', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderGovernancePolls([
                Object.assign({}, POLLS[0], { question: '<img src=x onerror=alert(1)>' })
            ]));
            expect($('.gov-poll-question img').length).to.equal(0);
        });
    });

    describe('the two halves fail independently', function () {

        it('a hub outage leaves the on-chain poll half rendering', function () {
            const { $ } = loadPage({
                [POLLS_URL]:     { total: 2, data: POLLS },
                [PROPOSALS_URL]: { __fail: { status: 503, responseJSON: { error: 'Hub unreachable' } } }
            });
            expect($('.gov-poll-row').length).to.equal(2);
        });

        it('a hub outage renders as UNKNOWN, never as "no proposals"', function () {
            // Saying the federation has no proposals when the hub could not be
            // read is a claim about consensus state this page cannot make.
            const { $ } = loadPage({
                [POLLS_URL]:     { total: 2, data: POLLS },
                [PROPOSALS_URL]: { __fail: { status: 503, responseJSON: { error: 'Hub unreachable' } } }
            });
            expect($('#governance-proposals .gov-unavailable-error').length).to.equal(1);
            expect($('#governance-proposals').text()).to.include('unknown rather than empty');
            expect($('#governance-proposals .gov-unavailable-empty').length).to.equal(0);
        });

        it('a genuinely empty proposal set renders the EMPTY state, distinct from the outage one', function () {
            const { $ } = loadPage({ [POLLS_URL]: { data: POLLS }, [PROPOSALS_URL]: { total: 0, data: [] } });
            expect($('#governance-proposals .gov-unavailable-empty').length).to.equal(1);
            expect($('#governance-proposals .gov-unavailable-error').length).to.equal(0);
        });

        it('a poll-half failure leaves the proposal half rendering', function () {
            const { $ } = loadPage({
                [POLLS_URL]:     { __fail: { status: 500, responseJSON: { error: 'index down' } } },
                [PROPOSALS_URL]: { total: 1, data: PROPOSALS }
            });
            expect($('.gov-proposal-row').length).to.equal(1);
            expect($('#governance-polls .gov-unavailable-error').length).to.equal(1);
        });

        it('fetches both halves rather than chaining one on the other', function () {
            // Chaining would let a hub outage stop the on-chain read from ever
            // being issued.
            const { seen } = loadPage({ [POLLS_URL]: { data: POLLS }, [PROPOSALS_URL]: { data: PROPOSALS } });
            expect(seen).to.have.members([POLLS_URL, PROPOSALS_URL]);
        });
    });
});
