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


// Lift a top-level `var NAME = ...;` out of the source so the sandbox evaluates the
// SHIPPED value rather than a copy the test invents.
function extractVar(name) {
    const m = new RegExp('^var ' + name + ' = .*;$', 'm').exec(SRC);
    if (!m) throw new Error('var not found in xchain.js: ' + name);
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
        // singleEmbedUrl parses candidate URLs with no base, so a relative one throws
        // rather than resolving; it needs the constructor, not a location.
        URL:       dom.window.URL,
    });
    const program = [
        extractVar('DEFAULT_EMBED_RATIO'),
        extractFn('escapeHtml'),
        extractFn('stripHtml'),
        extractFn('highlightSearchTerm'),
        extractFn('buildSandboxedContentDoc'),
        extractFn('isNull'),
        extractFn('formatHash'),
        extractFn('singleEmbedUrl'),
        ';({ escapeHtml: escapeHtml, stripHtml: stripHtml, highlightSearchTerm: highlightSearchTerm, buildSandboxedContentDoc: buildSandboxedContentDoc, formatHash: formatHash, singleEmbedUrl: singleEmbedUrl })',
    ].join('\n');
    const fns = vm.runInContext(program, context);
    return { fns, dom };
}

// Run the height-report shim that buildSandboxedContentDoc() embeds, in a context
// where the body's measured height is ours to control. Returns the messages it posted
// to the parent, a `fire` to dispatch a window event, and the mutable `state` whose
// bodyHeight stands in for the content reflowing. Layout is faked because jsdom has
// none; what is under test is which box the shim measures and when it re-reports.
function runHeightShim({ bodyHeight, marginTop = 8, marginBottom = 8 }) {
    const script = buildSandboxedContentDocFn()('<div>art</div>').match(/<script>([\s\S]*?)<\/script>/)[1];
    const dom    = new JSDOM('<!DOCTYPE html><body><div>art</div></body>');
    const posted = [];
    const state  = { bodyHeight };
    const listeners = {};
    dom.window.document.body.getBoundingClientRect = () => ({ height: state.bodyHeight });
    const context = vm.createContext({
        // No ResizeObserver here (jsdom has none), so the shim must still work off
        // plain load/resize events - the path every older browser takes too.
        window: {
            addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
            getComputedStyle: () => ({ marginTop: marginTop + 'px', marginBottom: marginBottom + 'px' }),
        },
        document:   dom.window.document,
        parent:     { postMessage: (msg) => posted.push(msg) },
        setTimeout: () => {},   // the late-poll timers are driven explicitly via fire()
    });
    vm.runInContext(script, context);
    return { posted, state, script, fire: (type) => (listeners[type] || []).forEach((fn) => fn()) };
}

// buildSandboxedContentDoc lives in the extracted-function sandbox, which is built
// per-test; grab a fresh copy rather than leaning on describe-scoped state.
function buildSandboxedContentDocFn() {
    return loadClientFns().fns.buildSandboxedContentDoc;
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
    let escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, formatHash, singleEmbedUrl;

    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, formatHash, singleEmbedUrl } } = loadClientFns());
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

        // The viewer resizes itself from the child's own reports, so the report must be
        // a FIXED POINT: apply it, re-measure, get the same number. The first shim
        // reported documentElement.scrollHeight, which is floored at the iframe's
        // viewport height, and the parent added 16px to it. Each resize therefore
        // echoed back 16px taller and the page grew without end (TDOGE FAIRYWINK).
        it('reports the body box plus its margins, not the viewport-floored scrollHeight', function () {
            const { posted, fire, script } = runHeightShim({ bodyHeight: 840 });
            // scrollHeight on documentElement can never fall below the frame's own
            // height, so a report built from it can only ratchet upward.
            expect(script).to.not.contain('documentElement.scrollHeight');
            fire('load');
            expect(posted).to.have.lengthOf(1);
            expect(posted[0].type).to.equal('xchain-iframe-height');
            expect(posted[0].height).to.equal(840 + 8 + 8);  // body box + its two margins
        });

        it('suppresses repeat reports of an unchanged height (no resize pump)', function () {
            const { posted, fire, state } = runHeightShim({ bodyHeight: 840 });
            fire('load');
            fire('resize');
            fire('resize');
            expect(posted, 'an unchanged height must not be re-posted').to.have.lengthOf(1);
            state.bodyHeight = 500;                          // content genuinely reflowed
            fire('resize');
            expect(posted).to.have.lengthOf(2);
            expect(posted[1].height).to.equal(500 + 16);
        });

        it('the page hands the viewer a URL, never a srcdoc string (cross-lock)', function () {
            // srcdoc/blob:/data: documents INHERIT this page's CSP, whose frame-src
            // admits only 'self', youtube and soundcloud - which is why token art
            // embedding any other host rendered as a broken-page placeholder. The
            // fetched /content-viewer document carries its own policy instead.
            const click = SRC.slice(SRC.indexOf("$('#loadCustomContentButton').click"));
            expect(click).to.not.contain("attr('srcdoc'");
            expect(click).to.contain("attr('src', '/content-viewer')");
            // The content follows over postMessage once the frame says it is listening.
            expect(SRC).to.contain('xchain-iframe-ready');
            expect(SRC).to.contain('xchain-iframe-content');
        });

        it('the parent applies the reported height verbatim and clamps it (cross-lock)', function () {
            // Any constant added here re-enters the child's resize handler with a bigger
            // number every round trip, which is exactly the runaway this pair fixes.
            const handler = SRC.slice(SRC.indexOf('xchain-iframe-height'));
            expect(handler).to.not.match(/d\.height\s*\+\s*\d/);
            expect(handler).to.contain('MAX_CUSTOM_CONTENT_HEIGHT');
            expect(SRC).to.match(/MAX_CUSTOM_CONTENT_HEIGHT\s*=\s*\d+/);
            expect(handler).to.contain('Math.min');
        });
    });

    // Custom content that is only an embed is framed directly on the token page, because
    // a host sending `frame-ancestors *` refuses to load beneath the viewer's opaque
    // origin. That makes singleEmbedUrl() a security boundary: whatever it accepts gets a
    // frame on the explorer's own page, so it must carry across a URL and nothing else.
    describe('singleEmbedUrl() (which custom content is hoisted onto the page)', function () {
        const WRAPPED = '<div style="position:relative;width:100%;padding-top:66%;overflow:hidden;background:black;">'
            + '<iframe src="https://art.example/piece/1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allowfullscreen></iframe>';

        it('hoists a wrapped single embed and keeps the author aspect ratio', function () {
            const embed = singleEmbedUrl(WRAPPED);
            expect(embed).to.not.equal(null);
            expect(embed.url).to.equal('https://art.example/piece/1');
            expect(embed.ratio).to.equal(66);
        });

        it('falls back to 16:9 when the author states no ratio', function () {
            expect(singleEmbedUrl('<iframe src="https://art.example/p"></iframe>').ratio).to.equal(56.25);
        });

        for (const [label, html] of Object.entries({
            'a script beside the embed':   '<iframe src="https://art.example/p"></iframe><script>alert(1)</script>',
            'two embeds':                  '<iframe src="https://a.example/x"></iframe><iframe src="https://b.example/y"></iframe>',
            'an image beside the embed':   '<iframe src="https://art.example/p"></iframe><img src="https://art.example/i.png">',
            'text beside the embed':       '<div>read me<iframe src="https://art.example/p"></iframe></div>',
            'no embed at all':             '<div style="padding-top:66%">just art</div>',
            'a javascript: URL':           '<iframe src="javascript:alert(1)"></iframe>',
            'a data: URL':                 '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
            'a blob: URL':                 '<iframe src="blob:https://explorer.example/abc"></iframe>',
            'a plain http URL':            '<iframe src="http://art.example/p"></iframe>',
            'a relative URL':              '<iframe src="/TDOGE/api/token/X"></iframe>',
            'a protocol-relative URL':     '<iframe src="//art.example/p"></iframe>',
            'an empty src':                '<iframe src=""></iframe>',
        })) {
            it('refuses to hoist ' + label + ', leaving it to the sandboxed viewer', function () {
                expect(singleEmbedUrl(html), label + ' must not be hoisted').to.equal(null);
            });
        }

        it('carries across the URL only, never the author markup', function () {
            // An onload handler on the author's own iframe must not survive: the frame the
            // page renders is built from scratch and given exactly one attribute from them.
            const embed = singleEmbedUrl('<iframe src="https://art.example/p" onload="alert(1)"></iframe>');
            expect(embed).to.not.equal(null);
            expect(Object.keys(embed).sort()).to.deep.equal(['ratio', 'url']);
            expect(JSON.stringify(embed)).to.not.contain('alert');
        });

        it('the hoisted frame is sandboxed exactly like the viewer (cross-lock)', function () {
            // Both frames render the same untrusted content; a sandbox that drifts between
            // them would quietly make one path weaker than the other.
            const src = SRC.match(/var CUSTOM_CONTENT_SANDBOX = '([^']*)'/);
            expect(src, 'CUSTOM_CONTENT_SANDBOX must be declared').to.not.equal(null);
            const tpl = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/token.html'), 'utf8');
            const markup = tpl.match(/id="customContentViewer"[^>]*sandbox="([^"]*)"/);
            expect(src[1].split(' ').sort()).to.deep.equal(markup[1].split(' ').sort());
            expect(src[1]).to.not.contain('allow-same-origin');
            // The page it now sits on is the explorer's own, so top-level navigation would
            // let an embed steer the reader away from it.
            expect(src[1]).to.not.contain('allow-top-navigation');
        });
    });

    // src/content/sandbox/content-viewer.html is the document the token page points
    // its sandboxed frame at. It takes the art over postMessage, so its acceptance
    // rules are a security surface in their own right: one sender, one write.
    describe('content-viewer.html (the sandboxed viewer shell)', function () {
        const SHELL = path.resolve(__dirname, '../../src/content/sandbox/content-viewer.html');

        // Boot the shell in jsdom with its script live. Messages are dispatched with an
        // explicit `source` because jsdom's own postMessage leaves it null, which is
        // indistinguishable from the impostor case the shell is supposed to refuse. In a
        // top-level document window.parent === window, so the window itself stands in
        // for the embedding page.
        function bootShell() {
            const dom = new JSDOM(fs.readFileSync(SHELL, 'utf8'), {
                runScripts: 'dangerously',
                url: 'https://explorer.example/content-viewer',
            });
            const seen = [];
            dom.window.addEventListener('message', (e) => seen.push(e.data));
            const settle = () => new Promise((resolve) => dom.window.setTimeout(resolve, 0));
            const send = (data, source = dom.window) =>
                dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source }));
            return { dom, seen, settle, send };
        }

        const ART = '<!DOCTYPE html><html><body><h1 id="art">art</h1></body></html>';

        it('announces itself to the parent, which is what releases the content', async function () {
            const { seen, settle } = bootShell();
            await settle();
            expect(seen.map(d => d && d.type)).to.contain('xchain-iframe-ready');
        });

        it('writes the document it is handed (scripts intact, not innerHTML-stripped)', async function () {
            const { dom, settle, send } = bootShell();
            await settle();
            send({ type: 'xchain-iframe-content', doc: ART });
            await settle();
            expect(dom.window.document.getElementById('art'), 'the art must be written into the document').to.not.equal(null);
        });

        it('takes exactly one write, so the art cannot be swapped out later', async function () {
            const { dom, settle, send } = bootShell();
            await settle();
            send({ type: 'xchain-iframe-content', doc: ART });
            await settle();
            send({
                type: 'xchain-iframe-content',
                doc:  '<!DOCTYPE html><html><body><h1 id="replaced">replaced</h1></body></html>',
            });
            await settle();
            expect(dom.window.document.getElementById('replaced'), 'a second write must be refused').to.equal(null);
            expect(dom.window.document.getElementById('art')).to.not.equal(null);
        });

        it('ignores a message that is not from the parent frame', async function () {
            const { dom, settle, send } = bootShell();
            await settle();
            // Same payload, wrong sender: how a nested or sibling frame would try to
            // feed the viewer content the embedding page never approved.
            send({ type: 'xchain-iframe-content', doc: ART }, null);
            await settle();
            expect(dom.window.document.getElementById('art'), 'only the parent may supply content').to.equal(null);
        });

        it('ignores a message whose doc is not a string', async function () {
            const { dom, settle, send } = bootShell();
            await settle();
            send({ type: 'xchain-iframe-content', doc: { toString: 'not a string' } });
            await settle();
            expect(dom.window.document.body.querySelector('h1')).to.equal(null);
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
