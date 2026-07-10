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
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

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
        extractFn('isNull'),
        extractFn('formatHash'),
        ';({ escapeHtml: escapeHtml, stripHtml: stripHtml, highlightSearchTerm: highlightSearchTerm, buildSandboxedContentDoc: buildSandboxedContentDoc, formatHash: formatHash })',
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

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    let escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, formatHash;

    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, formatHash } } = loadClientFns());
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
            // Listener side: the source guards on the same type string and a finite height.
            expect(SRC).to.match(/d\.type === ['"]xchain-iframe-height['"]/);
            expect(SRC).to.contain("isFinite(d.height)");
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
});
