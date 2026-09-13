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
 * The formatter module split out of xchain.js (spec M2.1).
 *
 * A move like this fails in exactly two ways, and both are quiet.
 *
 * It fails by leaving a copy behind: xchain.js still declaring formatAmount
 * would shadow or be shadowed depending on load order, and the two would then
 * drift with nothing to say so. So this asserts the migrated names appear in
 * formatters.js and NOWHERE else in the client tree.
 *
 * And it fails by changing behaviour under cover of "just moving code". The
 * behavioural cases below are the ones the existing suites already pinned on
 * these functions before the move - an absent amount rendering the word "null",
 * a /token/null href built from a native-coin leg - restated here against the
 * new home so the move is proven to have carried the fixes with it.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT   = path.resolve(__dirname, '..', '..');
const JS_DIR = path.join(ROOT, 'src', 'content', 'js');
const FORMATTERS_SRC = fs.readFileSync(path.join(JS_DIR, 'formatters.js'), 'utf8');
const CLIENT_SRC     = fs.readFileSync(path.join(JS_DIR, 'xchain.js'), 'utf8');

const F = require(path.join(JS_DIR, 'formatters.js'));

// The names that moved. Kept as a list rather than derived, because the point
// of the assertion is that this SET is what left xchain.js.
const MIGRATED = [
    'isNull', 'nullToBlank', 'escapeHtml', 'stripHtml',
    'formatAmount', 'formatLocks', 'isNftToken', 'getTokenIcon', 'getNetworkIcon',
    'formatLink', 'formatHash', 'formatLinkAmount', 'formatCoinLegAmount',
    'formatNativeCoinLeg', 'ownershipBadge', 'formatLivestamp'
];

describe('formatters module (M2.1)', function () {

    describe('the migration itself', function () {

        it('declares every migrated helper', function () {
            const missing = MIGRATED.filter((n) => !new RegExp('^function ' + n + '\\(', 'm').test(FORMATTERS_SRC));
            assert.deepEqual(missing, [], 'helpers that did not arrive in formatters.js: ' + missing.join(', '));
        });

        it('leaves NO copy behind in xchain.js', function () {
            // A surviving duplicate is the failure mode of this refactor: both
            // definitions run, the later wins by load order, and a fix applied to
            // one of them has no effect for reasons nothing on the page explains.
            const left = MIGRATED.filter((n) => new RegExp('^function ' + n + '\\(', 'm').test(CLIENT_SRC));
            assert.deepEqual(left, [], 'helpers still declared in xchain.js as well: ' + left.join(', '));
        });

        it('is declared in no other client file either', function () {
            const others = fs.readdirSync(JS_DIR)
                .filter((f) => f.endsWith('.js') && f !== 'formatters.js' && f !== 'xchain.js')
                // The vendored libraries are not ours and are not searched: a
                // minified bundle can contain any identifier by coincidence.
                .filter((f) => !/^(jquery|bootstrap|chart|chartjs|moment|numeral|math|highlight|livestamp|swagger|throttle)/.test(f));
            const dupes = [];
            for(const f of others){
                const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
                for(const n of MIGRATED)
                    if(new RegExp('^function ' + n + '\\(', 'm').test(src)) dupes.push(f + ' declares ' + n);
            }
            assert.deepEqual(dupes, [], dupes.join('\n'));
        });

        it('exports every helper for Node, so a suite can drive the real one', function () {
            const missing = MIGRATED.filter((n) => typeof F[n] !== 'function');
            assert.deepEqual(missing, [], 'not exported: ' + missing.join(', '));
        });
    });

    describe('the name table the column configs bind to', function () {

        it('resolves each registered name to the shipped function', function () {
            assert.equal(F.XCFormatters.amount, F.formatAmount);
            assert.equal(F.XCFormatters.link, F.formatLink);
            assert.equal(F.XCFormatters.hash, F.formatHash);
            assert.equal(F.XCFormatters.livestamp, F.formatLivestamp);
            assert.equal(F.XCFormatters.isNull, F.isNull);
        });

        it('every registered name points at a function, none at undefined', function () {
            const broken = Object.keys(F.XCFormatters).filter((k) => typeof F.XCFormatters[k] !== 'function');
            assert.deepEqual(broken, [], 'formatter names bound to nothing: ' + broken.join(', '));
        });

        it('is LOUD about an unknown name rather than rendering a blank column', function () {
            const errors = [];
            const real = console.error;
            console.error = (m) => errors.push(String(m));
            let got;
            try { got = F.xcFormatter('amonut'); } finally { console.error = real; }
            assert.equal(got, null);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /no formatter named "amonut"/);
        });

        it('does not answer for an inherited Object member', function () {
            const real = console.error;
            console.error = () => {};
            try {
                assert.equal(F.xcFormatter('toString'), null);
                assert.equal(F.xcFormatter('constructor'), null);
            } finally { console.error = real; }
        });
    });

    describe('behaviour carried across the move', function () {

        it('formatAmount renders nothing for an absent amount, never the word null', function () {
            assert.equal(F.formatAmount(null), '');
            assert.equal(F.formatAmount(undefined), '');
            assert.equal(F.formatAmount(''), '');
        });

        it('formatAmount leaves real amounts alone and groups thousands, zero included', function () {
            assert.equal(F.formatAmount(0), '0');
            assert.equal(F.formatAmount('1000'), '1,000');
            assert.equal(F.formatAmount('1234567.89012345'), '1,234,567.89012345');
        });

        it('formatLink renders the label alone rather than a dead /token/null href', function () {
            // A native-coin leg carries no tick, which used to build /token/null.
            assert.equal(F.formatLink('/RDOGE/token/null', 'DOGE'), 'DOGE');
            assert.equal(F.formatLink('/RDOGE/token/undefined', 'DOGE'), 'DOGE');
            assert.match(F.formatLink('/RDOGE/token/XCHAIN', 'XCHAIN'), /^<a href="\/RDOGE\/token\/XCHAIN"/);
        });

        it('formatHash truncates with the full value in the title, escaping both ends', function () {
            assert.equal(F.formatHash(null), '');
            assert.equal(F.formatHash('abc'), 'abc');
            const out = F.formatHash('a'.repeat(64), 8);
            assert.match(out, /title="a{64}"/);
            assert.match(out, />a{8}…</);
            // An INVALID-status ANCHOR persists a raw BLOCK_HASH verbatim, and
            // this string reaches .html(); the escape is the guard.
            const evil = F.formatHash('<img src=x onerror=alert(1)>'.repeat(3), 10);
            assert.equal(evil.includes('<img'), false);
        });

        it('escapeHtml neutralises every character that can break out of markup', function () {
            assert.equal(F.escapeHtml('<a href="x">&\'</a>'),
                '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
            assert.equal(F.escapeHtml(null), '');
            assert.equal(F.escapeHtml(undefined), '');
        });

        it('isNull treats empty string as absent, and zero as present', function () {
            assert.equal(F.isNull(''), true);
            assert.equal(F.isNull(null), true);
            assert.equal(F.isNull(undefined), true);
            assert.equal(F.isNull(0), false);
            assert.equal(F.isNull(false), false);
        });

        it('nullToBlank blanks an absent value so jQuery .text() cannot write "null"', function () {
            assert.equal(F.nullToBlank(null), '');
            assert.equal(F.nullToBlank(0), 0);
        });

        it('formatCoinLegAmount renders a NATIVE leg as text, and a dash when it carries nothing', function () {
            assert.equal(F.formatCoinLegAmount('RDOGE', 'RDOGE', null, '1000'), '1,000 RDOGE');
            assert.equal(F.formatCoinLegAmount('RDOGE', null, null, null), '-');
        });

        it('stripHtml parses INERTLY in a browser realm and returns text only', function () {
            const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
            const win = dom.window;
            win.eval(FORMATTERS_SRC);
            // An onerror handler must not fire while the value is being read;
            // the previous implementation assigned to a live element's innerHTML,
            // which is itself an execution sink.
            win.fired = false;
            const out = win.stripHtml('<img src=x onerror="window.fired=true">hello');
            assert.equal(out, 'hello');
            assert.equal(win.fired, false, 'stripHtml executed the markup it was asked to strip');
        });
    });
});
