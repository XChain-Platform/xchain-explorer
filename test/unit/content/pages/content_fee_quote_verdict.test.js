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
 * Fee-quote sandbox verdict render. Drives the SHIPPED renderFeeQuoteResult,
 * sliced out of the inline script in src/content/html/fees.html, against the
 * shipped #fee-quote-result node in JSDOM.
 *
 * What it protects: the indexer's `valid` is a THREE-state verdict. true means
 * the action was dry-run and accepted, false means it was checked and rejected,
 * and null means a correctly-priced static quote whose on-chain validity was
 * never computed (the DEPLOY/EXECUTE gas-schedule lane, and the preflight path's
 * busy answer). A truthiness test collapses null into false, so a real
 * payable fee is badged red "Invalid" directly above its own required-fee rows,
 * which is the most misleading possible rendering of "we did not check".
 *
 * The feequote busy, denied, guard-inert and no-FEE_DESTINATION answers carry
 * valid:FALSE beside their marker, and fee-exempt carries valid:TRUE without a
 * dry-run, so the marker has to win over `valid` for all of them.
 *
 * The oracle sandbox below it reads a bare { error } (no `valid` field) on an
 * indexer failure, which must never reach the green badge.
 */

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const FEES_HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/fees.html'), 'utf8');
const XCHAIN_JS = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/formatters.js'), 'utf8');

// Slice a top-level function out of a source string by walking braces, so the
// test runs shipped code rather than a copy that can drift.
function extractFn(src, name, where) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found in ' + where + ': ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// Run one shipped renderer against its own result node; `fn` names the function and
// `nodeId` the element it writes into.
function render(quote, fn = 'renderFeeQuoteResult', nodeId = 'fee-quote-result') {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="' + nodeId + '"></div></body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', network: 'testnet' };
    // isNull and escapeHtml come from the shipped helpers rather than stubs,
    // because the renderer's own escaping rides on them.
    dom.window.eval(`
        function tokenUrl(coin, tick){ return "/" + coin + "/token/" + encodeURIComponent(String(tick)); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        ${extractFn(XCHAIN_JS, 'isNull', 'xchain.js/formatters.js')}
        ${extractFn(XCHAIN_JS, 'escapeHtml', 'xchain.js/formatters.js')}
    `);
    dom.window.eval(extractFn(FEES_HTML, fn, 'fees.html'));
    dom.window[fn](quote);
    const $ = dom.window.$;
    const html = $('#' + nodeId).html();
    const rowFor = (label) => {
        const th = $('#' + nodeId + ' th').filter(function(){ return $(this).text().trim() === label; });
        return th.length ? th.next('td').text().trim() : null;
    };
    return { html, rowFor, badge: $('#' + nodeId + ' .badge').first(),
        alert: $('#' + nodeId + ' .alert').first() };
}

// The static-quote lane in xchain-indexer/src/actions/index.js prices DEPLOY and
// EXECUTE from the gas schedule and downgrades a true verdict to null, keeping
// requiredFeeNative / requiredFeeSats payable.
const STATIC_QUOTE = {
    action: 'DEPLOY', supported: true, valid: null, validated: false, staticQuote: true,
    requiredFeeNative: '0.00123456', requiredFeeSats: 123456,
    note: 'DEPLOY is priced from the gas schedule without a dry-run'
};

describe('fee-quote sandbox verdict rendering', function () {

    it('badges a payable static quote as not checked rather than invalid', function () {
        const r = render(STATIC_QUOTE);
        expect(r.badge.text().trim()).to.equal('Not checked');
        expect(r.badge.attr('class')).to.contain('text-bg-secondary');
        expect(r.html).to.not.contain('text-bg-danger');
        // the fee it declined to validate is still shown as payable
        expect(r.rowFor('Required Native Fee')).to.contain('0.00123456');
    });

    it('surfaces the provenance fields that separate unchecked from invalid', function () {
        const r = render(STATIC_QUOTE);
        expect(r.rowFor('Validated')).to.equal('No');
        expect(r.rowFor('Static Quote')).to.contain('no on-chain validation');
        expect(r.rowFor('Note')).to.contain('without a dry-run');
    });

    it('keeps the red badge for a verdict the indexer actually rejected', function () {
        const r = render({ action: 'ISSUE', supported: true, valid: false, validated: true, error: 'unknown TICK' });
        expect(r.badge.text().trim()).to.equal('Invalid');
        expect(r.badge.attr('class')).to.contain('text-bg-danger');
        expect(r.rowFor('Detail')).to.equal('unknown TICK');
    });

    it('keeps the green badge for a dry-run verdict that passed', function () {
        const r = render({ action: 'ISSUE', supported: true, valid: true, validated: true, requiredFeeSats: 1000 });
        expect(r.badge.text().trim()).to.equal('Valid');
        expect(r.badge.attr('class')).to.contain('text-bg-success');
    });

    it('badges a busy retryable quote as not checked and names the busy state', function () {
        const r = render({ action: 'ISSUE', supported: true, valid: null, busy: true, retryable: true });
        expect(r.badge.text().trim()).to.equal('Not checked');
        expect(r.rowFor('Busy')).to.equal('Yes, retryable');
    });

    it('escapes a hostile note rather than injecting it', function () {
        const r = render({ action: 'ISSUE', supported: true, valid: null, note: '<img src=x onerror=alert(1)>' });
        expect(r.html).to.not.contain('<img src=x');
        expect(r.html).to.contain('&lt;img');
    });
});

describe('fee-quote sandbox verdict rendering', function () {

    // The indexer's feequote sends valid:false on several answers that are not
    // verdicts; each shape below is copied from its quote_surfaces / quote_answers
    // return, and none of them may badge red.
    const NOT_A_VERDICT = [
        ['an unquotable XEXEC', 'Not quotable', { action: 'XEXEC', supported: false, valid: false, denied: true,
            error: 'native fee pre-flight not supported for XEXEC (pay the fee in XCHAIN)' }],
        ['an unquotable BATCH', 'Not quotable', { action: 'BATCH', supported: false, valid: false, denied: true,
            error: 'native fee pre-flight not supported for BATCH (pay the fee in XCHAIN)' }],
        ['a DEPLOY the gas schedule cannot price', 'Not quotable', { action: 'DEPLOY', supported: false,
            valid: false, denied: true, blockIndex: 10, error: 'native fee pre-flight not supported for DEPLOY' }],
        ['an admission-capped busy quote', 'Not checked', { action: 'ISSUE', supported: true, valid: false,
            busy: true, retryable: true, error: 'fee quote busy (8 quotes already pending); retry shortly' }],
        ['a lock-wait busy quote', 'Not checked', { action: 'ISSUE', supported: true, valid: false, busy: true,
            retryable: true, retryAfterMs: 2000, error: 'fee quote busy (the indexer is processing a block)' }],
        ['a controller guard the public path will not run', 'Not quotable', { action: 'SEND', supported: false,
            valid: false, validated: true, status: 'invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED:token',
            guardInert: true, error: 'native fee pre-flight not supported for a controller-bound SEND' }],
        ['a guard sentinel carried only in status', 'Not quotable', { action: 'SEND', supported: false,
            valid: false, validated: true, status: 'invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED:token' }],
        ['a chain with no FEE_DESTINATION', 'Not quotable', { action: 'ISSUE', supported: false, valid: false,
            error: 'native coin fee not enabled (no FEE_DESTINATION configured)' }]
    ];
    for (const [what, label, quote] of NOT_A_VERDICT) {
        it('badges ' + what + ' as ' + label.toLowerCase() + ', never invalid', function () {
            const r = render(quote);
            expect(r.badge.text().trim()).to.equal(label);
            expect(r.badge.attr('class')).to.contain('text-bg-secondary');
            expect(r.html).to.not.contain('text-bg-danger');
            // the reason the indexer gave is still shown
            expect(r.rowFor('Detail')).to.equal(quote.error === undefined ? null : quote.error);
        });
    }

    it('badges a fee-exempt answer as exempt rather than a dry-run pass', function () {
        const r = render({ action: 'DISPENSE', supported: true, valid: true, feeExempt: true,
            requiredFeeSats: 0, note: 'DISPENSE carries no protocol fee' });
        expect(r.badge.text().trim()).to.equal('Fee exempt');
        expect(r.html).to.not.contain('text-bg-success');
        expect(r.rowFor('Fee Exempt')).to.equal('Yes');
    });

    it('keeps the red badge for a static-lane rejection the indexer computed', function () {
        const r = render({ action: 'DEPLOY', supported: true, valid: false, validated: false,
            staticQuote: true, error: 'fee output below the minimum' });
        expect(r.badge.text().trim()).to.equal('Invalid');
        expect(r.badge.attr('class')).to.contain('text-bg-danger');
    });
});

describe('oracle fee-quote sandbox verdict rendering', function () {

    const renderOracle = (quote) => render(quote, 'renderOracleQuoteResult', 'oracle-quote-result');

    // oraclefeequote's internal failures carry `error` and no `valid` at all.
    for (const error of ['indexer not ready', 'no indexed block to quote against', 'failed to compute oracle fee quote']) {
        it('shows "' + error + '" as a warning, never a Valid badge', function () {
            const r = renderOracle({ error });
            expect(r.html).to.not.contain('text-bg-success');
            expect(r.alert.text().trim()).to.equal(error);
        });
    }

    it('shows a generic warning for a null reply instead of throwing', function () {
        const r = renderOracle(null);
        expect(r.html).to.not.contain('text-bg-success');
        expect(r.alert.text().trim()).to.equal('Quote is not valid.');
    });

    it('keeps the warning for a quote the indexer refused', function () {
        const r = renderOracle({ valid: false, error: 'no oracle price for USD' });
        expect(r.alert.text().trim()).to.equal('no oracle price for USD');
    });

    it('keeps the green badge and fee rows for a valid quote', function () {
        const r = renderOracle({ valid: true, oracleAddress: 'bc1qoracle', requiredFeeNative: '0.00001000',
            requiredFeeSats: 1000, belowDust: false, note: 'add a native-coin output' });
        expect(r.badge.text().trim()).to.equal('Valid');
        expect(r.badge.attr('class')).to.contain('text-bg-success');
        expect(r.rowFor('Required Native Fee')).to.contain('0.00001000');
    });
});
