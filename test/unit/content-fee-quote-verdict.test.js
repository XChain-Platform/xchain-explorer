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
 * never computed (the DEPLOY/EXECUTE gas-schedule lane and the busy / denied /
 * fee-exempt branches). A truthiness test collapses null into false, so a real
 * payable fee is badged red "Invalid" directly above its own required-fee rows,
 * which is the most misleading possible rendering of "we did not check".
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const FEES_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/fees.html'), 'utf8');
const XCHAIN_JS = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');

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

function render(quote) {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="fee-quote-result"></div></body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', network: 'testnet' };
    // isNull and escapeHtml come from the shipped helpers rather than stubs,
    // because the renderer's own escaping rides on them.
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        ${extractFn(XCHAIN_JS, 'isNull', 'xchain.js/formatters.js')}
        ${extractFn(XCHAIN_JS, 'escapeHtml', 'xchain.js/formatters.js')}
    `);
    dom.window.eval(extractFn(FEES_HTML, 'renderFeeQuoteResult', 'fees.html'));
    dom.window.renderFeeQuoteResult(quote);
    const $ = dom.window.$;
    const html = $('#fee-quote-result').html();
    const rowFor = (label) => {
        const th = $('#fee-quote-result th').filter(function(){ return $(this).text().trim() === label; });
        return th.length ? th.next('td').text().trim() : null;
    };
    return { html, rowFor, badge: $('#fee-quote-result .badge').first() };
}

// The static-quote lane in xchain-indexer/src/actions.js prices DEPLOY and
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
