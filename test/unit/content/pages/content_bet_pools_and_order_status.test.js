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
 * Two render gaps a Tier-3 browser drive found, both of the same shape: the data
 * existed and the surface reading it asked the wrong question.
 *
 * 1. A RESOLVED market showed 0 stakes on every outcome. getBetFeedPools summed
 *    only bet_status='open' rows, borrowing the indexer's normative SETTLEMENT
 *    predicate for a DISPLAY job. At settlement that predicate is right (a bet
 *    that already took a terminal credit must not be counted twice); on a market
 *    page it empties the table the moment bets become 'won'/'lost', so a market
 *    that took 150 tokens rendered as one nobody bet on, directly above its own
 *    bets table listing those bets. The filter is now a blacklist of 'invalid' -
 *    the rows the indexer's own writer creates precisely so they "never enter a
 *    pool sum" (bet.js:397) - because a whitelist is what went stale here.
 *
 * 2. An ORDER's lifecycle status was served and rendered nowhere, so a filled
 *    order and an open one read identically on the order's own page. The "Action
 *    Status" row above it is the ACTION's parse validity and says "valid" for
 *    both.
 *
 * The pool query is pinned through the SHIPPED SQL text rather than a live DB:
 * what regressed was one predicate in one statement, and that is exactly what a
 * text assertion can hold without a fixture chain.
 *********************************************************************/

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const math = require('mathjs');

// The bet feed readers live in the polls and bets reader family since db/index.js
// became the composition root, so the pinned bodies are read from there.
const SRC_DB   = srcText('src/db/readers/polls_bets.js');
const SRC_JS   = srcText('src/content/js/xchain.js');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/action.html'), 'utf8');
const BET_FEED_HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/bet_feed.html'), 'utf8');

// Slice a method body out of the source by walking braces, the technique the
// sibling content-client tests use, so this reads shipped code not a copy.
function extractFn(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) throw new Error('not found in source: ' + signature);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

function renderBetFeedPools(pools) {
    const callback = extractFn(BET_FEED_HTML, 'function(o)');
    const dom = new JSDOM('<!DOCTYPE html><body>' + BET_FEED_HTML + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.math = math;
    dom.window.XC = { coin: 'BTC', query: '42', name: 'Bitcoin', network: 'mainnet', pageInfo: {} };
    dom.window.eval(`
        function isNull(value){ return value === null || value === undefined; }
        function tokenUrl(coin, tick){ return '/' + coin + '/token/' + tick; }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(){ return 'soon'; }
        function formatAmount(value){ return String(value); }
        function updatePageInfo(){}
        function statusClass(){ return 'primary'; }
        function esc(value){ return String(value); }
        var numeral = function(value){ return { format: function(){ return String(value); } }; };
        var moment = { unix: function(){ return { utcOffset: function(){ return { format: function(){ return 'when'; } }; } }; } };
    `);
    dom.window.eval('(' + callback + ')')({
        action_index: 42,
        label: 'Precision market',
        source: 'oracle',
        tick: 'TOKEN',
        fee: '0',
        deadline: 1,
        expire_at: 2,
        min_amount: null,
        allow_list: null,
        block_list: null,
        block_index: 1,
        feed_status: 'open',
        outcome_labels: ['first', 'second'],
        pools,
        timeline: [],
        details: null
    });
    return [...dom.window.document.querySelectorAll('#feed-pools tbody tr')]
        .map((row) => row.lastElementChild.textContent);
}

describe('bet feed pools: a resolved market still shows its stakes', () => {

    const body = extractFn(SRC_DB, 'async getBetFeedPools(');

    it('does not filter the pool down to open bets only', () => {
        assert.ok(!/bs\.status\s*=\s*'open'/.test(body),
            "getBetFeedPools still sums only bet_status='open', which empties on resolve");
    });

    it('excludes exactly the rows that escrowed nothing', () => {
        assert.ok(/bs\.status\s*<>\s*'invalid'/.test(body),
            'the pool sum must exclude invalid bets, which never escrowed');
    });

    it('still groups and orders by outcome so the page can index positionally', () => {
        assert.ok(/GROUP BY m\.outcome/.test(body));
        assert.ok(/ORDER BY m\.outcome ASC/.test(body));
    });

});

describe('bet feed: the winning outcome is served', () => {

    const body = extractFn(SRC_DB, 'async getBetFeedWinningOutcome(');

    it('reads the resolve leg', () => {
        assert.ok(/FROM\s+bet_resolves/.test(body.replace(/\s+/g, ' ').replace(/ /g, ' ')) ||
                  /bet_resolves/.test(body), 'must read bet_resolves');
    });

    it('honours only a VALID resolve', () => {
        // An invalid resolve stores the outcome the oracle CLAIMED and settled
        // nothing; serving it would name a winner for a rejected resolve.
        assert.ok(/bs\.status\s*=\s*'valid'/.test(body),
            'an invalid resolve must never supply a winning outcome');
    });

    it('is wired into the feed record', () => {
        assert.ok(/row\.winning_outcome\s*=\s*await this\.getBetFeedWinningOutcome\(/.test(SRC_DB),
            'getBetFeedInfo does not attach winning_outcome');
    });

});

describe('order detail: the lifecycle status is rendered', () => {

    it('the card has a row for it', () => {
        assert.ok(/class="order-state-status"/.test(ACTION_HTML),
            'action.html has no order-state-status cell');
    });

    it('the renderer fills it from state.status', () => {
        const body = extractFn(SRC_JS, 'function showOrderDetails(');
        assert.ok(/order-state-status/.test(body) && /data\.state\.status/.test(body),
            'showOrderDetails does not render data.state.status');
    });

    it('colours each lifecycle status distinctly, and zero-like values are not dropped', () => {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        dom.window.eval(extractFn(SRC_JS, 'function offerStatusClass('));
        const cls = dom.window.offerStatusClass;
        assert.strictEqual(cls('complete'), 'success');
        assert.strictEqual(cls('cancelled'), 'danger');
        assert.strictEqual(cls('expired'), 'danger');
        // In flight, not terminal: warned rather than failed.
        assert.strictEqual(cls('cancelling'), 'warning text-dark');
        assert.strictEqual(cls('expiring'), 'warning text-dark');
        assert.strictEqual(cls('open'), 'primary');
    });

});

describe('bet feed page: the winner is marked on its own outcome row', () => {

    const html = fs.readFileSync(
        path.resolve(__dirname, '..', '..', '../../src/content/html/bet_feed.html'), 'utf8');

    it('compares the winning outcome strictly, so outcome 0 can win', () => {
        // A truthy test drops outcome 0, which is a perfectly ordinary winner and
        // was the winner on the market this was driven against.
        assert.ok(/Number\(d\.winning_outcome\)\s*===\s*i/.test(html),
            'the winner comparison must be strict and numeric');
        assert.ok(/d\.winning_outcome !== null/.test(html),
            'the winner check must guard null explicitly rather than relying on truthiness');
    });

});

describe('bet feed page: pool percentages retain decimal precision', () => {

    it('[REGRESSION] computes implied percentages without converting pool amounts to floats', () => {
        const percentages = renderBetFeedPools([
            { outcome: 0, pool: '33350000000000000000000000000000000000000000000', bet_count: 1 },
            { outcome: 1, pool: '66650000000000000000000000000000000000000000000', bet_count: 1 }
        ]);
        assert.deepStrictEqual(percentages, ['33.4%', '66.7%']);
    });

    it('keeps the one-decimal display for ordinary exact pool splits', () => {
        const percentages = renderBetFeedPools([
            { outcome: 0, pool: '1', bet_count: 1 },
            { outcome: 1, pool: '3', bet_count: 1 }
        ]);
        assert.deepStrictEqual(percentages, ['25.0%', '75.0%']);
    });

});

describe('bet feed pools: the DECIMAL sum tail is trimmed', () => {

    const body = extractFn(SRC_DB, 'async getBetFeedPools(');

    it('trims the pool through the same helper the sibling sum uses', () => {
        // SUM(CAST(... AS DECIMAL(65,18))) returns 18 places whatever the token's
        // own DECIMALS, so a 0-decimals token rendered '100.000000000000000000'.
        // This only became visible once the filter above stopped returning nothing
        // for a settled market.
        assert.ok(/this\.trimAmountTail\(r\.pool\)/.test(body),
            'the pool sum must be trimmed like getOracleFeesEarned trims its own');
    });

    it('keeps outcome and bet_count numeric for positional rendering', () => {
        assert.ok(/outcome:\s*Number\(r\.outcome\)/.test(body));
        assert.ok(/bet_count:\s*Number\(r\.bet_count\)/.test(body));
    });

});
