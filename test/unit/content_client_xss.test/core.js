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

const fs = require('fs');
const path = require('path');
const { expect, SRC, extractFn, loadClientFns, inspect, PAYLOADS } = require('../content_client_xss.test.js');

let escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash;
let CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES;

function fresh() { return { height: null, applied: 0 }; }

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
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
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
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
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
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
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
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
    });
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
    });

    describe('buildSandboxedContentDoc() + resize contract', function () {
        it('the sandboxed iframe carries a sandbox without allow-same-origin', function () {
            // The whole protection is the sandbox; assert it exists and is NOT neutered.
            const tpl = fs.readFileSync(path.resolve(__dirname, '../../../src/content/html/token.html'), 'utf8');
            const m = tpl.match(/id="customContentViewer"[^>]*sandbox="([^"]*)"/);
            expect(m, 'customContentViewer must declare a sandbox').to.not.equal(null);
            expect(m[1]).to.contain('allow-scripts');
            expect(m[1]).to.not.contain('allow-same-origin'); // would re-grant explorer-origin access
        });
    });
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
    });

    describe('buildSandboxedContentDoc() + resize contract', function () {
        // The frame reports documentElement.scrollHeight, which for %/vh-sized content
        // is the frame's own viewport. Applying it and honouring the echo that the
        // resize triggers grew the frame forever (TBTC STARE: a height:100% div,
        // +16px per echo). These lock the guard's four rules.
        describe('customContentHeightToApply() resize guard', function () {
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
    });
    });
});

describe('client XSS: src/content/js/xchain.js (jsdom regression harness)', function () {
    before(function () {
        ({ fns: { escapeHtml, stripHtml, highlightSearchTerm, buildSandboxedContentDoc, customContentHeightToApply, formatHash,
                  CUSTOM_CONTENT_MAX_HEIGHT, CUSTOM_CONTENT_MAX_RESIZES } } = loadClientFns());
    });

    describe('buildSandboxedContentDoc() + resize contract', function () {
        describe('customContentHeightToApply() resize guard', function () {
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
    });
});
