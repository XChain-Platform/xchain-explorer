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
 * BET detail render leg. Drives the SHIPPED showBetDetails against the SHIPPED
 * #info-bet markup sliced out of action.html, in the harness
 * content-client-price-detail.test.js uses.
 *
 * What it protects: the market's ORACLE FEE, a scalar percentage of the pot,
 * against the reserved-slot collision that has recurred across several action
 * types (BROADCAST, PRICE, a BATCH child row, and BET). getActionData
 * overwrites the payload's `fee` property with the generic protocol-fee RECORD
 * after the detail query runs, so a renderer that reads `data.fee` here prints
 * the literal string "[object Object]% of the pot" on a market whose creating
 * action also carried a protocol fee.
 *
 * db.action-detail-slot-collision.test.js holds the SQL half of the invariant:
 * no detail query may select an unaliased `fee`. This is the renderer half, and
 * it is the half that was missing every one of those four times: the alias can
 * be in place and correct while the renderer still reads the slot beside it.
 * The payload below therefore carries BOTH, exactly as the live endpoint does.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
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
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-bet">');
    if (start < 0) throw new Error('#info-bet panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-stake"', start);
    if (end < 0) throw new Error('could not bound the #info-bet panel');
    return ACTION_HTML.slice(start, end);
}

function renderBetDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));

    dom.window.XC = { coin: 'BTC' };
    /* Helpers the renderer leans on, kept naive so anything the assertions
     * observe is showBetDetails' own doing. The pools lookup is a live fetch,
     * so $.getJSON is inert here: this leg is about the fields the payload
     * already carries. */
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(t){ return 'in a while'; }
        function formatAmount(a){ return String(a); }
        var numeral  = function(n){ return { format: function(){ return String(n); } }; };
        var moment   = { unix: function(){ return { utcOffset: function(){ return { format: function(){ return 'when'; } }; } }; } };
        $.getJSON = function(){ return { done: function(){} }; };
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showBetDetails'));
    dom.window.showBetDetails(data);
    const $ = dom.window.$;
    return {
        fee:  $('#info-bet .bet-fee').text().trim(),
        resolveOutcome:     $('#info-bet .bet-resolve-outcome').text().trim(),
        resolveOutcomeHtml: $('#info-bet .bet-resolve-outcome').html(),
        resolveHidden:      $('#info-bet .bet-resolve-fields').hasClass('d-none'),
        html: $('#info-bet').html()
    };
}

/* The generic protocol-fee RECORD getActionData writes into the reserved `fee`
 * slot. Shape copied from getActionFeeData; only its being an object matters. */
const PROTOCOL_FEE = {
    source: 'bcrt1qsource', destination: 'bcrt1qdest', tick: 'XCP',
    amount: '0.5', method: 'destroy'
};

const FEED = {
    bet_kind: 'feed', label: 'Will block 900000 confirm before Friday?',
    outcome_labels: ['no', 'yes'], tick: 'PEPE', bet_fee: '2.5', fee: PROTOCOL_FEE,
    deadline: 1785000000, refund_window: 86400, expire_at: 1785600000,
    min_amount: '10', allow_list: null, block_list: null,
    feed_status: 'open', details: null, details_json: null, action_index: 4242
};

describe('BET detail render: the oracle fee is a number, not the protocol-fee record @regression', function () {

    it('[REGRESSION] renders the oracle percentage when a protocol fee also occupies data.fee', function () {
        const out = renderBetDetails(FEED);
        expect(out.fee).to.not.contain('[object Object]');
        expect(out.fee).to.contain('2.5');
        expect(out.fee).to.equal('2.5% of the pot (oracle fee)');
    });

    it('renders the oracle percentage when there is no protocol fee at all', function () {
        // The slot is null far more often than not, which is why the collision
        // survives casual testing: the bug only shows on an action that paid one.
        const out = renderBetDetails({ ...FEED, fee: null });
        expect(out.fee).to.equal('2.5% of the pot (oracle fee)');
    });

    it('renders a zero fee as zero rather than as an absent field', function () {
        // A 0% oracle cut is a real, common market and is not "no fee field".
        expect(renderBetDetails({ ...FEED, bet_fee: '0' }).fee).to.equal('0% of the pot (oracle fee)');
    });

    it('shows a dash when the market carries no oracle fee', function () {
        const out = renderBetDetails({ ...FEED, bet_fee: null });
        expect(out.fee).to.equal('-');
        expect(out.fee).to.not.contain('undefined');
    });

    it('the renderer never reads the reserved `fee` slot', function () {
        /* The assertions above only fail on a payload that carries a protocol
         * fee, and the one that shipped for five days did not. This reads the
         * source instead, so the class of mistake fails here whatever the
         * fixture happens to hold. */
        const fn = extractFn('showBetDetails');
        expect(fn).to.not.match(/\bdata\.fee\b/,
            'showBetDetails must read the aliased bet_fee: getActionData overwrites data.fee with the '
            + 'generic protocol-fee record, which renders as "[object Object]"');
        expect(fn).to.contain('data.bet_fee');
    });
});

/* A BET format 3 (resolve) declares the OUTCOME that settles the market, and the
 * indexer persists it in bet_resolves.outcome. The detail query selected only the
 * resolve's feed reference, so the panel showed which market was settled and never
 * what it was settled to. An INVALID resolve makes the omission total: it settles
 * nothing and the outcome it claimed appears on no page at all, since the feed page
 * serves only the outcome a VALID resolve produced (db.js getBetFeedWinningOutcome). */
const RESOLVE = {
    bet_kind: 'resolve', feed_ref: 4242, feed_status: 'resolved',
    resolve_outcome: 2, status: 'valid', fee: PROTOCOL_FEE, action_index: 4310
};

describe('BET detail render: a resolve shows the outcome it declared', function () {

    it('renders the declared outcome rather than dropping it', function () {
        const out = renderBetDetails(RESOLVE);
        expect(out.resolveHidden).to.equal(false);
        expect(out.resolveOutcome).to.equal('2');
    });

    it('renders outcome 0 as a result, not as an absent field', function () {
        // Outcome indexes are zero-based, so the first outcome is the falsy one.
        expect(renderBetDetails({ ...RESOLVE, resolve_outcome: 0 }).resolveOutcome).to.equal('0');
    });

    it('labels a rejected resolve as a CLAIM, never as the winning outcome', function () {
        // An invalid resolve stores what the oracle claimed and settles nothing;
        // printing it bare would invent a settlement that never happened.
        const out = renderBetDetails({ ...RESOLVE, status: 'invalid: OUTCOME (range)', feed_status: 'open' });
        expect(out.resolveOutcome).to.contain('2');
        expect(out.resolveOutcome).to.contain('claimed');
    });

    it('states no claim on a valid resolve, which really did settle the market', function () {
        expect(renderBetDetails(RESOLVE).resolveOutcome).to.not.contain('claimed');
    });

    it('escapes the outcome, which is an on-chain attacker-supplied value', function () {
        const out = renderBetDetails({ ...RESOLVE, resolve_outcome: '<img src=x onerror=alert(1)>' });
        expect(out.resolveOutcomeHtml).to.not.contain('<img src=x');
        expect(out.resolveOutcomeHtml).to.contain('&lt;img');
    });

    it('hides the row on a cancel, which shares the panel and declares no outcome', function () {
        const out = renderBetDetails({ bet_kind: 'cancel', feed_ref: 4242,
                                       feed_status: 'cancelled', status: 'valid', fee: null });
        expect(out.resolveHidden).to.equal(true);
    });

    it('hides the row on a wager, whose own outcome is the bet it placed', function () {
        expect(renderBetDetails({ bet_kind: 'bet', feed_ref: 4242, outcome: 1, amount: '10',
                                  bet_status: 'open', status: 'valid', fee: null }).resolveHidden).to.equal(true);
    });

    it('shows a dash rather than a blank cell when the payload carries no outcome', function () {
        expect(renderBetDetails({ ...RESOLVE, resolve_outcome: null }).resolveOutcome).to.equal('-');
    });
});
