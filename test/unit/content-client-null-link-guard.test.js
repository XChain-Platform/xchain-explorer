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
 * formatLink's dead-link guard.
 *
 * ORDER, SWAP and DISPENSER use an EMPTY tick to mean the chain's native coin.
 * The cell text was already blanked by the null-render guards, but the anchor
 * wrapping it still pointed at /{COIN}/token/null, so every native-coin pair
 * shipped a dead link on exactly the side that made it native. Same
 * stringified-null class as the cell-text and formatAmount routes before it,
 * one layer further out, and guarded here at the helper so every call site is
 * covered at once rather than the handful anyone remembers.
 *
 * The label must survive: the value is genuinely native coin, so the cell keeps
 * whatever it was going to say and simply stops being a link.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');

function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

function linker() {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval('function isNull(v){ return (v===null||v===undefined||v===""); }');
    dom.window.eval('function getTokenIcon(t){ return "/icon/" + t + ".png"; }');
    dom.window.eval(extractFn('formatLink'));
    return dom.window.formatLink;
}

describe('formatLink: a stringified-null target is not a link', () => {

    const formatLink = linker();

    it('renders no anchor for a /token/null target', () => {
        const out = formatLink('/RDOGE/token/null', null, null);
        assert.ok(!/<a /.test(out), 'a dead /token/null link was still rendered: ' + out);
        assert.ok(!/null/.test(out), 'the word "null" reached the cell: ' + out);
    });

    it('renders no anchor for an undefined segment either', () => {
        assert.ok(!/<a /.test(formatLink('/RDOGE/token/undefined', null, null)));
    });

    it('keeps the label when there is one, minus the link', () => {
        assert.strictEqual(formatLink('/RDOGE/token/null', 'DOGE', false), 'DOGE');
    });

    it('still links a real token', () => {
        const out = formatLink('/RDOGE/token/CAMPD', 'CAMPD', false);
        assert.ok(/<a href="\/RDOGE\/token\/CAMPD"/.test(out), out);
        assert.ok(/CAMPD<\/a>/.test(out), out);
    });

    it('does not strip a token whose name merely contains null', () => {
        const out = formatLink('/RDOGE/token/NULLCOIN', 'NULLCOIN', false);
        assert.ok(/<a href="\/RDOGE\/token\/NULLCOIN"/.test(out), out);
    });

    it('fires on the final PATH SEGMENT only, not anywhere in the url', () => {
        // The discriminating case, and the reason the guard is anchored: a search
        // link legitimately ends in the word null as a query VALUE, and stripping
        // it would break a working link. An unanchored guard eats this one.
        const out = formatLink('/RDOGE/search?query=null', 'null', false);
        assert.ok(/<a href="\/RDOGE\/search\?query=null"/.test(out),
            'an unanchored guard stripped a legitimate query value: ' + out);
    });

    it('still links an address or block route', () => {
        assert.ok(/<a href="\/RDOGE\/block\/3382"/.test(formatLink('/RDOGE/block/3382', '3,382', false)));
    });

});
