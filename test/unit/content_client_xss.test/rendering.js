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
 * Client-side XSS regression harness: src/content/js/xchain.js
 *
 * The stored-XSS fix (afa867d) hardened three free-text sinks in the browser
 * bundle: escapeHtml(), stripHtml(), highlightSearchTerm(). That file is a
 * 3400-line jQuery bundle with NO tests, so the fix was logic-verified only.
 * This harness locks it in by extracting the three functions from the REAL
 * source (not a copy) and evaluating them in a jsdom-backed vm context, then
 * firing the canonical XSS payloads at them.
 *
 * It tests the shipped code: the functions are sliced out of xchain.js by name
 * via brace-matching, so a regression in the production file fails this test.
 *
 * Run: mocha test/unit/content-client-xss.test.js --timeout 0
 */

'use strict';

const { expect, loadClientFns, inspect, PAYLOADS, renderBetDetails } = require('../content_client_xss.test.js');

let formatHash;

function loadFormatHash() {
    ({ fns: { formatHash } } = loadClientFns());
}

function liveElements(dom) {
    // Only elements the RENDER introduced count; the static panel markup
    // (table/tbody/tr/th/td/div) is part of the shipped page.
    // Structural markup the panel or the renderer itself is allowed to emit
    // (the <br> separator between outcome labels, the pools table, badges).
    // Anything OUTSIDE this set came from attacker-controlled bytes.
    const structural = new Set(['table','tbody','tr','th','td','div','span','pre','a','thead','br']);
    const els = Array.from(dom.window.document.body.querySelectorAll('*'));
    return {
        foreign: els.map(e => e.tagName.toLowerCase()).filter(t => !structural.has(t)),
        hasHandler: els.some(e => Array.from(e.attributes).some(a => /^on/i.test(a.name))),
    };
}

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(loadFormatHash);

    describe('formatHash() stored-XSS (hash-shaped fields on invalid-status rows)', function () {
        // showAnchorDetails() renders anchor block_hash/ledger_hash/actions_hash/
        // contract_hash/state_root/block_merkle_root via formatHash into jQuery
        // .html(). Those are 64-hex on VALID anchors, but an INVALID-status ANCHOR
        // (anyone can broadcast a malformed ANCHOR-format DOGE tx) persists its raw
        // BLOCK_HASH verbatim (VARCHAR(64), lowercased but HTML metachars survive).
        it('neutralizes an attribute-breakout payload in the long (truncated) branch', function () {
            // 30 chars > default len 16, so it takes the <span title="..."> branch.
            const payload = '"><img src=x onerror=alert(1)>';
            const out = formatHash(payload, 16);
            const { tags, hasHandler } = inspect(out);
            expect(tags, 'only the wrapping span may survive').to.deep.equal(['span']);
            expect(hasHandler, 'no on* handler may reach the DOM').to.equal(false);
            expect(out).to.not.match(/<img\b/i);
        });

        it('neutralizes a payload in the short (untruncated) branch', function () {
            const payload = '<svg onload=alert(1)>';   // 21 chars; use a larger len to hit the short branch
            const out = formatHash(payload, 64);
            const { tags, hasHandler } = inspect(out);
            expect(tags).to.deep.equal([]);
            expect(hasHandler).to.equal(false);
        });

        it('leaves a real 64-hex hash intact (escaping is a no-op on hex)', function () {
            const hex = 'a'.repeat(64);
            const out = formatHash(hex, 16);
            expect(out).to.equal('<span title="' + hex + '">' + 'a'.repeat(16) + '…</span>');
        });

        it('returns empty string for null/undefined (no "null" leak)', function () {
            expect(formatHash(null)).to.equal('');
            expect(formatHash(undefined)).to.equal('');
        });
    });
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(loadFormatHash);

    // Rendering safety for BET markets. LABEL, OUTCOMES and DETAILS arrive from
    // the chain and are fully attacker-controlled.
    describe('showBetDetails(): hostile market fields render inert', function () {
        Object.entries(PAYLOADS).forEach(([name, payload]) => {
            it('renders a hostile LABEL (' + name + ') as inert text', function () {
                const { dom, text } = renderBetDetails({
                    bet_kind: 'feed', action_index: 1, label: payload,
                    outcome_labels: [], details: null, details_json: null,
                });
                const { foreign, hasHandler } = liveElements(dom);
                expect(foreign, 'no live elements from the label').to.deep.equal([]);
                expect(hasHandler, 'no inline event handlers').to.equal(false);
                // The bytes must still be SHOWN (escaped), not silently dropped.
                expect(text).to.contain(payload.slice(0, 12));
            });

            it('renders hostile OUTCOMES (' + name + ') as inert text', function () {
                const { dom } = renderBetDetails({
                    bet_kind: 'feed', action_index: 1, label: 'ok',
                    outcome_labels: ['fine', payload], details: null, details_json: null,
                });
                const { foreign, hasHandler } = liveElements(dom);
                expect(foreign).to.deep.equal([]);
                expect(hasHandler).to.equal(false);
            });

            it('renders a hostile DETAILS payload (' + name + ') as inert data', function () {
                const { dom } = renderBetDetails({
                    bet_kind: 'feed', action_index: 1, label: 'ok', outcome_labels: [],
                    details: 'base64-ish', details_json: { title: payload, nested: { x: payload } },
                });
                const { foreign, hasHandler } = liveElements(dom);
                expect(foreign, 'DETAILS JSON must never become markup').to.deep.equal([]);
                expect(hasHandler).to.equal(false);
            });
        });
    });
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(loadFormatHash);

    describe('showBetDetails(): hostile market fields render inert', function () {
        it('shows undecodable DETAILS as escaped raw bytes, never as markup', function () {
            const { dom, text } = renderBetDetails({
                bet_kind: 'feed', action_index: 1, label: 'ok', outcome_labels: [],
                details: '<img src=x onerror=alert(1)>', details_json: null,
            });
            const { foreign, hasHandler } = liveElements(dom);
            expect(foreign).to.deep.equal([]);
            expect(hasHandler).to.equal(false);
            expect(text).to.contain('unparsed base64 payload');
        });

        it('never fetches a URL found inside DETAILS (SSRF-guard stance)', function () {
            const { fetched } = renderBetDetails({
                bet_kind: 'feed', action_index: 42, label: 'ok', outcome_labels: [],
                details: 'x',
                details_json: { image: 'http://169.254.169.254/latest/meta-data/', link: 'https://evil.example/x' },
            });
            // The only request the market panel may make is its own pools read.
            expect(fetched).to.deep.equal(['/BTC/api/bet_feed/42']);
        });

        it('renders a hostile bet status badge inertly on the wager shape', function () {
            const { dom } = renderBetDetails({
                bet_kind: 'bet', action_index: 9, feed_ref: 1, outcome: 0,
                amount: '1.0', bet_status: '<img src=x onerror=alert(1)>', settled_block: null,
            });
            const { foreign, hasHandler } = liveElements(dom);
            expect(foreign).to.deep.equal([]);
            expect(hasHandler).to.equal(false);
        });
    });
});
