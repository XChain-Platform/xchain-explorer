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

const fs   = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const SRC_DB   = fs.readFileSync(path.resolve(__dirname, '../../src/db.js'), 'utf8');
const SRC_JS   = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

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
        path.resolve(__dirname, '../../src/content/html/bet_feed.html'), 'utf8');

    it('compares the winning outcome strictly, so outcome 0 can win', () => {
        // A truthy test drops outcome 0, which is a perfectly ordinary winner and
        // was the winner on the market this was driven against.
        assert.ok(/Number\(d\.winning_outcome\)\s*===\s*i/.test(html),
            'the winner comparison must be strict and numeric');
        assert.ok(/d\.winning_outcome !== null/.test(html),
            'the winner check must guard null explicitly rather than relying on truthiness');
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
