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

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_PATH = path.resolve(__dirname, '../../src/content/js/xchain.js');
// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
const SRC = fs.readFileSync(SRC_PATH, 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');

// Slice a top-level `function NAME(...){ ... }` out of the source by walking
// braces from its opening `{` to the matching `}`. The three target functions
// keep their `{`/`}` balanced inside strings/regex (verified), so a plain depth
// counter is sufficient and far less brittle than line offsets.
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
    const body = SRC.slice(start, i);
    if (!/\}\s*$/.test(body)) throw new Error('failed to extract balanced body for ' + name);
    return body;
}

// Slice a top-level numeric `var NAME = <number>;` out of the source, so the
// resize-guard function under test runs against the SHIPPED limits.
function extractVar(name) {
    const m = SRC.match(new RegExp('^var ' + name + '\\s*=\\s*[0-9]+;', 'm'));
    if (!m) throw new Error('numeric var not found in xchain.js: ' + name);
    return m[0];
}

// Build a sandbox whose only host objects are document + DOMParser (what
// stripHtml needs); JS intrinsics (String/RegExp/Object) come with the vm
// context. The three functions are defined there and handed back.
function loadClientFns() {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    const context = vm.createContext({
        document:  dom.window.document,
        DOMParser: dom.window.DOMParser,
    });
    const program = [
        extractFn('escapeHtml'),
        extractFn('stripHtml'),
        extractFn('highlightSearchTerm'),
        extractFn('buildSandboxedContentDoc'),
        extractVar('CUSTOM_CONTENT_MIN_HEIGHT'),
        extractVar('CUSTOM_CONTENT_MAX_HEIGHT'),
        extractVar('CUSTOM_CONTENT_MAX_RESIZES'),
        extractFn('customContentHeightToApply'),
        extractFn('isNull'),
        extractFn('formatHash'),
        ';({ escapeHtml: escapeHtml, stripHtml: stripHtml, highlightSearchTerm: highlightSearchTerm, buildSandboxedContentDoc: buildSandboxedContentDoc, customContentHeightToApply: customContentHeightToApply, formatHash: formatHash, CUSTOM_CONTENT_MAX_HEIGHT: CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES: CUSTOM_CONTENT_MAX_RESIZES })',
    ].join('\n');
    const fns = vm.runInContext(program, context);
    return { fns, dom };
}

// Parse an HTML fragment inertly and report which element tag names it produced
// and whether any carry an inline event handler / on* attribute.
function inspect(html) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    const wrap = dom.window.document.createElement('div');
    // Use the inert template route so probing the result does not itself execute.
    const tpl = dom.window.document.createElement('template');
    tpl.innerHTML = String(html);
    wrap.appendChild(tpl.content.cloneNode(true));
    const els = Array.from(wrap.querySelectorAll('*'));
    const tags = els.map(e => e.tagName.toLowerCase());
    const hasHandler = els.some(e =>
        Array.from(e.attributes).some(a => /^on/i.test(a.name)));
    return { tags, hasHandler, text: wrap.textContent };
}

const PAYLOADS = {
    imgOnerror:  '<img src=x onerror=alert(1)>',
    svgOnload:   '"<svg onload=alert(1)>"',
    attrBreak:   '" onmouseover="alert(1)',
    scriptTag:   '<script>alert(document.cookie)</script>',
    mixed:       'hello <b>bold</b> <img src=x onerror=alert(1)> world',
};

// Render the SHIPPED showBetDetails against the SHIPPED #info-bet markup in a real
// jsdom + jQuery window. BET's LABEL / OUTCOMES / DETAILS are attacker-controlled
// on-chain bytes, so this is a direct test of the rendering-safety requirement:
// hostile payloads must come out as inert text, never live elements.
function renderBetDetails(data) {
    const ACTION_HTML = fs.readFileSync(
        path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');
    // Slice the real #info-bet panel out of action.html so the test drives the
    // shipped selectors; a renamed class here fails rather than silently no-ops.
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-bet">');
    if (start < 0) throw new Error('#info-bet panel not found in action.html');
    const end = ACTION_HTML.indexOf('<!-- STAKE action -->', start);
    const panel = ACTION_HTML.slice(start, end);

    const dom = new JSDOM('<!DOCTYPE html><body>' + panel + '</body>',
        { runScripts: 'outside-only' });
    const jq = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');
    dom.window.eval(jq);

    // Minimal stubs for the page helpers showBetDetails leans on. formatLink and
    // formatAmount are NOT under test here; they are given deliberately naive
    // implementations so that any escaping the assertions observe is showBetDetails'
    // own doing rather than a helper's.
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function formatLivestamp(v){ return String(v); }
        var moment = function(){ return moment; };
        moment.unix = function(){ return { utcOffset: function(){ return { format: function(){ return 'ts'; } }; } }; };
        var numeral = function(){ return { format: function(){ return '0'; } }; };
    `);
    dom.window.eval(extractFn('isNull'));
    dom.window.eval(extractFn('showBetDetails'));
    // The pools table is fetched over $.getJSON; stub it out so the render is
    // synchronous and no network is touched (a DETAILS URL must never be fetched).
    let fetched = [];
    dom.window.$.getJSON = function(url){ fetched.push(url); return { done: function(){} }; };
    dom.window.showBetDetails(data);
    return { dom, html: dom.window.document.body.innerHTML,
             text: dom.window.document.body.textContent, fetched };
}

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    let escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash;
    let CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES;

    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
    });

    describe('escapeHtml()', function () {
        it('neutralizes every HTML-significant character', function () {
            const out = escapeHtml('<>&"\'');
            expect(out).to.equal('&lt;&gt;&amp;&quot;&#39;');
        });

        Object.entries(PAYLOADS).forEach(([name, payload]) => {
            it('renders ' + name + ' as inert text (no live elements)', function () {
                const out = escapeHtml(payload);
                expect(out).to.not.match(/<(img|svg|script|b)\b/i);
                const { tags } = inspect(out);
                expect(tags, 'no elements should be produced from escaped output').to.deep.equal([]);
            });
        });

        it('coerces null/undefined to empty string (no "null" leak into the DOM)', function () {
            expect(escapeHtml(null)).to.equal('');
            expect(escapeHtml(undefined)).to.equal('');
        });
    });

    describe('highlightSearchTerm()', function () {
        it('escapes untrusted text and only introduces the highlight <span>', function () {
            const out = highlightSearchTerm('world', PAYLOADS.mixed);
            const { tags, hasHandler } = inspect(out);
            // The img/b in the on-chain text must NOT survive as elements; the
            // only markup is the highlight span around the matched term.
            expect(tags).to.deep.equal(['span']);
            expect(hasHandler).to.equal(false);
            expect(out).to.contain('<span class="highlight-search-term">world</span>');
        });

        Object.entries(PAYLOADS).forEach(([name, payload]) => {
            it('never emits a live element when ' + name + ' is the text', function () {
                const out = highlightSearchTerm('zzz', payload); // term that won't match
                const { tags, hasHandler } = inspect(out);
                expect(tags).to.deep.equal([]);
                expect(hasHandler).to.equal(false);
            });
        });

        it('treats a regex-metacharacter search term literally (no thrown RegExp)', function () {
            const out = highlightSearchTerm('[a-z](', 'plain text');
            expect(out).to.equal('plain text'); // term not present, text unchanged & escaped
        });

        it('resists ReDoS from a catastrophic-looking term against long text', function () {
            const term = '(a+)+';                 // escaped to a literal, cannot backtrack
            const text = 'a'.repeat(60000);
            const start = process.hrtime.bigint();
            const out = highlightSearchTerm(term, text);
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            expect(ms, 'should complete well under a second').to.be.below(500);
            // No '(a+)+' substring in a run of 'a's → text passes through escaped, unhighlighted.
            expect(out).to.not.contain('highlight-search-term');
        });
    });

    describe('stripHtml()', function () {
        it('returns plain text and drops all markup', function () {
            expect(stripHtml(PAYLOADS.mixed)).to.equal('hello bold  world');
        });

        Object.entries(PAYLOADS).forEach(([name, payload]) => {
            it('extracts text from ' + name + ' without producing live nodes', function () {
                const out = stripHtml(payload);
                expect(out).to.not.match(/<[^>]+>/); // no tags survive
                const { tags } = inspect(out);
                expect(tags).to.deep.equal([]);
            });
        });

        it('parses inertly: does not mutate the live document during extraction', function () {
            const { fns, dom } = loadClientFns();
            fns.stripHtml('<img src=x onerror=alert(1)><script>x</script>');
            expect(dom.window.document.querySelectorAll('img,script').length).to.equal(0);
        });
    });

    // The custom-HTML token feature is protected by an iframe sandbox (no
    // allow-same-origin), NOT by escaping, so buildSandboxedContentDoc passes the
    // attacker HTML through verbatim. These tests lock the wrapper's structure and
    // the producer/consumer height-message contract, not escaping.
    describe('buildSandboxedContentDoc() + resize contract', function () {
        it('wraps the payload in a full document and embeds the height-report shim', function () {
            const doc = buildSandboxedContentDoc('<h1>art</h1>');
            expect(doc).to.match(/^<!DOCTYPE html>/i);
            expect(doc).to.contain('<h1>art</h1>');       // payload passed through (sandbox is the guard)
            expect(doc).to.contain('postMessage');
            expect(doc).to.contain('xchain-iframe-height');
        });

        it('producer message type matches the parent-side listener (cross-lock)', function () {
            // The shim posts {type:"xchain-iframe-height"}; the message handler in the
            // source must check that exact literal, or auto-resize silently breaks.
            const producer = buildSandboxedContentDoc('');
            expect(producer).to.contain('"xchain-iframe-height"');
            // Listener side: the source guards on the same type string and hands the
            // height to the guard function, which is where the finite check lives.
            expect(SRC).to.match(/d\.type !== ['"]xchain-iframe-height['"]/);
            expect(SRC).to.match(/customContentHeightToApply\(XC\.customContentResize, d\.height\)/);
            expect(extractFn('customContentHeightToApply')).to.contain('isFinite(reported)');
        });

        // The frame reports documentElement.scrollHeight, which for %/vh-sized content
        // is the frame's own viewport. Applying it and honouring the echo that the
        // resize triggers grew the frame forever (TBTC STARE: a height:100% div,
        // +16px per echo). These lock the guard's four rules.
        describe('customContentHeightToApply() resize guard', function () {
            function fresh() { return { height: null, applied: 0 }; }

            it('applies the reported height exactly (no +16 double count)', function () {
                const st = fresh();
                expect(customContentHeightToApply(st, 420)).to.equal(420);
                expect(st.height).to.equal(420);
            });

            it('ignores the echo of the height it just applied', function () {
                const st = fresh();
                customContentHeightToApply(st, 420);
                expect(customContentHeightToApply(st, 420)).to.equal(null);
                expect(customContentHeightToApply(st, 421)).to.equal(null); // sub-2px jitter
                expect(st.applied).to.equal(1);
            });

            it('a viewport-filling document converges instead of climbing', function () {
                // Simulate the live loop: the parent applies H, the frame's viewport
                // becomes H, the frame reports its viewport (H) back. Under the old
                // +16 rule that reads H+16 next time; under the guard it stops.
                const st = fresh();
                let frameHeight = 150;                       // iframe default before any report
                let applied = 0;
                for (let i = 0; i < 1000; i++) {
                    const report = Math.max(frameHeight, 380); // content is max(viewport, intrinsic video)
                    const next = customContentHeightToApply(st, report);
                    if (next === null) break;
                    frameHeight = next; applied++;
                }
                expect(frameHeight).to.equal(380);
                expect(applied).to.equal(1);
            });

            it('content sized to viewport-plus-a-constant is cut off by the resize budget', function () {
                // height: calc(100% + 10px): every echo legitimately differs by 10px, so
                // the echo guard alone cannot stop it. The per-load budget does.
                const st = fresh();
                let frameHeight = 150, rounds = 0;
                for (let i = 0; i < 10000; i++) {
                    const next = customContentHeightToApply(st, frameHeight + 10);
                    if (next === null) break;
                    frameHeight = next; rounds++;
                }
                expect(rounds).to.equal(CUSTOM_CONTENT_MAX_RESIZES);
                expect(frameHeight).to.be.below(150 + 10 * (CUSTOM_CONTENT_MAX_RESIZES + 1));
            });

            it('clamps to the ceiling and rejects non-numeric or non-finite reports', function () {
                expect(customContentHeightToApply(fresh(), 1e9)).to.equal(CUSTOM_CONTENT_MAX_HEIGHT);
                expect(customContentHeightToApply(fresh(), Infinity)).to.equal(null);
                expect(customContentHeightToApply(fresh(), NaN)).to.equal(null);
                expect(customContentHeightToApply(fresh(), '500')).to.equal(null);
                expect(customContentHeightToApply(fresh(), { valueOf: () => 500 })).to.equal(null);
            });

            it('the click handler resets the budget per load', function () {
                expect(SRC).to.match(/XC\.customContentResize = \{ height: null, applied: 0 \};\s*\n\s*el\.attr\('srcdoc'/);
            });
        });

        it('the sandboxed iframe carries a sandbox without allow-same-origin', function () {
            // The whole protection is the sandbox; assert it exists and is NOT neutered.
            const tpl = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/token.html'), 'utf8');
            const m = tpl.match(/id="customContentViewer"[^>]*sandbox="([^"]*)"/);
            expect(m, 'customContentViewer must declare a sandbox').to.not.equal(null);
            expect(m[1]).to.contain('allow-scripts');
            expect(m[1]).to.not.contain('allow-same-origin'); // would re-grant explorer-origin access
        });
    });

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

    // Rendering safety for BET markets. LABEL, OUTCOMES and DETAILS arrive from
    // the chain and are fully attacker-controlled.
    describe('showBetDetails(): hostile market fields render inert', function () {

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
