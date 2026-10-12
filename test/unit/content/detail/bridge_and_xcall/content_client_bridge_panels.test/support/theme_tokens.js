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
 * Explorer bridge surfaces (xchain-bridge.md section 13 / row 9,
 * xchain-token-bridge.md section 9 / row 8, policy spec section 10 / row 7).
 *
 * Drives the SHIPPED derivation and render in
 * src/content/js/xbridge_panels_render.js and the SHIPPED loadBridgePanels()
 * out of src/content/html/token.html, in the JSDOM-eval harness
 * content-client-xcall-timeline.test.js established.
 *
 * WHAT THIS PROTECTS, and why each case is here rather than eyeballed:
 *
 *  1. The explorer is PER-COIN ROUTED. A BTC node cannot read the DOGE ledger,
 *     so a bridged token's per-chain supply is not a query it can make: the
 *     numbers come from the hub's getbridgeinvariant, and the hub can be down,
 *     can serve a tick it never signed a transfer for, or can answer an error
 *     body. All three reach a naive renderer as "no rows", i.e. exactly like a
 *     token with no bridged copies. Telling a holder their bridged supply does
 *     not exist when the truth is "we could not ask" is the failure the
 *     unavailable / none split exists to prevent, so both states are pinned.
 *  2. The invariant is escrow >= supply, NEVER equality (nothing refuses a
 *     stranger's SEND to the escrow role address), so the delta is SIGNED:
 *     positive is a surplus and a warning, negative is a deficit and the alarm
 *     (base spec D65, AT6). A renderer that read |delta| would paint the alarm
 *     on a harmless surplus and, worse, the same badge on both.
 *  3. A transfer is ONE signed record with both legs on it and its direction
 *     DERIVED from src_chain, never stored (seam section 3). Two rows per
 *     transfer would invent a pairing the record does not carry.
 *  4. Every badge colour is an --xc-bridge-* token in BOTH theme files (D30):
 *     a literal is a colour a skin cannot reach.
 ********************************************************************/


'use strict';

const assert = require('node:assert/strict');
const { CLASSIC, SKIN, PAGE_HTML } = require('../../content_client_bridge_panels.test.js');

// The class names the shipped render module emits for a coloured badge.
const COLOURED = ['xc-bridge-state-ok', 'xc-bridge-state-surplus', 'xc-bridge-state-deficit',
                  'xc-bridge-state-unknown', 'xc-bridge-origin', 'xc-bridge-this-chain'];

function definedTokens(css) {
    return new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--xc-[\w-]+)\s*:/g)].map(m => m[1]));
}

describe('explorer bridge panels: every badge colour is a theme token (D30) @regression', function () {
    it('declares an --xc-bridge-* token for every badge state, in BOTH theme files', function () {
        const classic = definedTokens(CLASSIC);
        const skin    = definedTokens(SKIN);
        const missing = [];
        for (const cls of COLOURED) {
            // Each badge class needs the tokens the page style block actually
            // reads for it. Checked by EXACT name, not by prefix: a prefix test
            // passes on a half-declared family, because --xc-bridge-state-deficit-bg
            // and --xc-bridge-state-deficit-color share the same prefix and losing
            // one of them still leaves the other to satisfy the check.
            const wanted = (cls === 'xc-bridge-this-chain') ? ['--' + cls + '-bg']
                                                           : ['--' + cls + '-bg', '--' + cls + '-color'];
            for (const name of wanted) {
                if (!classic.has(name)) missing.push('classic/tokens.css does not declare ' + name);
                if (!skin.has(name))    missing.push('skin-demo/tokens.css does not declare ' + name);
            }
        }
        assert.deepEqual(missing, [], missing.join('\n'));
    });

    it('declares the SAME bridge token set in both files, so the skin is a drop-in', function () {
        const only = (a, b) => [...a].filter(n => n.startsWith('--xc-bridge-') && !b.has(n));
        const classic = definedTokens(CLASSIC);
        const skin    = definedTokens(SKIN);
        // An omitted token falls back to nothing and INVALIDATES the declaration
        // that reads it, so a partial skin breaks a badge rather than restyling it.
        assert.deepEqual(only(classic, skin), [], 'the skin is missing: ' + only(classic, skin).join(', '));
        assert.deepEqual(only(skin, classic), [], 'the skin declares extras: ' + only(skin, classic).join(', '));
    });
});

describe('explorer bridge panels: every badge colour is a theme token (D30) @regression', function () {
    it('the page style block reads those colours through var(), never as a literal', function () {
        const styles = [...PAGE_HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
        const bridgeRules = styles.split('}').filter(b => b.includes('xc-bridge'));
        assert.ok(bridgeRules.length >= 4, 'token.html carries no bridge style rules to check');
        for (const block of bridgeRules) {
            const body = block.slice(block.indexOf('{') + 1);
            for (const decl of body.split(';')) {
                const colon = decl.indexOf(':');
                if (colon === -1) continue;
                const value = decl.slice(colon + 1).trim();
                if (!value) continue;
                assert.match(value, /^var\(--xc-/,
                    'a bridge rule carries a literal a skin cannot reach: ' + decl.trim());
            }
        }
    });

    it('gives the skin a DIFFERENT value for every bridge token, or loading it changes nothing', function () {
        const valuesOf = (css) => {
            const out = {};
            for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--xc-bridge-[\w-]+)\s*:\s*([^;]+);/g))
                out[m[1]] = m[2].trim();
            return out;
        };
        const c = valuesOf(CLASSIC);
        const s = valuesOf(SKIN);
        const names = Object.keys(c);
        assert.ok(names.length >= 8, 'classic declares only ' + names.length + ' bridge tokens');
        const unmoved = names.filter(n => s[n] === c[n]);
        assert.deepEqual(unmoved, [], 'the skin reuses classic values for: ' + unmoved.join(', '));
    });
});
