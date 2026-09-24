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
const { srcText } = require('../../../helpers/source_text');

const SRC_PATH = path.resolve(__dirname, '..', '..', '../../src/content/js/xchain.js');
// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
const SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/formatters.js'), 'utf8');

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
        path.resolve(__dirname, '..', '..', '../../src/content/html/action.html'), 'utf8');
    // Slice the real #info-bet panel out of action.html so the test drives the
    // shipped selectors; a renamed class here fails rather than silently no-ops.
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-bet">');
    if (start < 0) throw new Error('#info-bet panel not found in action.html');
    const end = ACTION_HTML.indexOf('<!-- STAKE action -->', start);
    const panel = ACTION_HTML.slice(start, end);

    const dom = new JSDOM('<!DOCTYPE html><body>' + panel + '</body>',
        { runScripts: 'outside-only' });
    const jq = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8');
    dom.window.eval(jq);

    // Minimal stubs for the page helpers showBetDetails leans on. formatLink and
    // formatAmount are NOT under test here; they are given deliberately naive
    // implementations so that any escaping the assertions observe is showBetDetails'
    // own doing rather than a helper's.
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function tokenUrl(coin, tick){ return "/" + coin + "/token/" + encodeURIComponent(String(tick)); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function formatLivestamp(v){ return String(v); }
        var moment = function(){ return moment; };
        moment.unix = function(){ return { utcOffset: function(){ return { format: function(){ return 'ts'; } }; } }; };
        var numeral = function(){ return { format: function(){ return '0'; } }; };
    `);
    dom.window.eval(extractFn('isNull'));
    dom.window.eval(extractFn('detailBetStake_renderFeed'));
    dom.window.eval(extractFn('detailBetStake_renderAction'));
    dom.window.eval(extractFn('showBetDetails'));
    // The pools table is fetched over $.getJSON; stub it out so the render is
    // synchronous and no network is touched (a DETAILS URL must never be fetched).
    let fetched = [];
    dom.window.$.getJSON = function(url){ fetched.push(url); return { done: function(){} }; };
    dom.window.showBetDetails(data);
    return { dom, html: dom.window.document.body.innerHTML,
             text: dom.window.document.body.textContent, fetched };
}

module.exports = { expect, SRC, extractFn, loadClientFns, inspect, PAYLOADS, renderBetDetails };

require('./content_client_xss.test/support/core.js');
require('./content_client_xss.test/support/rendering.js');
