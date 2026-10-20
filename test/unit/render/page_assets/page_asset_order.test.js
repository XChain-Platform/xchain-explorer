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
 * Deferring is safe only if nothing reads a global before the script that
 * declares it has run. The browser runs a blocking or inline script where the
 * parser meets it and every deferred script afterwards, in document order,
 * before DOMContentLoaded. This replays that order over each page as sent and
 * checks what every script reads while it runs, callbacks excluded (those wait
 * for a ready handler, by which time everything has run).
 *********************************************************************/

'use strict';

const assert = require('assert');

const { compose, allPages } = require('./support/compose.js');
const { LIBRARIES, scanFile } = require('./support/page_closure.js');
const { scanScript } = require('./support/global_scan.js');
const { JSDOM } = require('jsdom');

const stripVersion = (url) => url.replace(/\?v=[0-9a-f]+$/, '');

// Each script on the page in document order: what it reads while it runs and
// what it declares, and whether the parser runs it in place.
function units(html){
    const out = [];
    for(const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){
        const attrs = m[1];
        if(/application\/json/.test(attrs)) continue;
        const src = (/\bsrc="([^"]+)"/.exec(attrs) || [])[1];
        if(!src){
            const scan = scanScript(m[2].replace(/\{[A-Z][A-Z_]*(?::[a-z0-9-]+)?\}/g, '0'));
            out.push({ name: 'inline script', deferred: false, reads: scan.parse, declares: tokensOf(scan) });
            continue;
        }
        const url = stripVersion(src);
        const lib = LIBRARIES[url];
        const scan = lib ? null : scanFile(url);
        out.push({
            name: url,
            deferred: /\bdefer\b/.test(attrs),
            reads: lib ? new Set(lib.needs || []) : scan.parse,
            declares: lib ? new Set(lib.provides) : tokensOf(scan)
        });
    }
    return out;
}

function tokensOf(scan){
    return new Set([...scan.provides.keys()].map((n) => 'id:' + n));
}

// Execution order: in-place scripts as met, then the deferred ones.
const executionOrder = (list) => [...list.filter((u) => !u.deferred), ...list.filter((u) => u.deferred)];

let builtinNames = null;
function isBuiltin(token){
    if(!builtinNames){
        const { window } = new JSDOM('');
        builtinNames = new Set(['module', 'require', 'exports', 'define']);
        for(let o = window; o; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => builtinNames.add(n));
        Object.getOwnPropertyNames(globalThis).forEach((n) => builtinNames.add(n));
        window.close();
    }
    return token.startsWith('id:') && builtinNames.has(token.slice(3));
}

function earlyReads(html){
    const defined = new Set();
    const early = [];
    for(const unit of executionOrder(units(html))){
        for(const t of unit.reads){
            if(t.startsWith('@') || t.startsWith('component:')) continue;
            if(!defined.has(t) && !isBuiltin(t)) early.push(unit.name + ' reads ' + t + ' before it is defined');
        }
        unit.declares.forEach((t) => defined.add(t));
    }
    return early;
}

describe('page asset groups: deferred scripts run in a safe order', function () {

    this.timeout(60000);

    it('never reads a global before its script has run, on any page', async () => {
        const bad = [];
        for(const file of allPages())
            earlyReads(await compose(file)).forEach((e) => bad.push(file + ': ' + e));
        assert.deepStrictEqual(bad, []);
    });

    it('registers xchain.js\'s ready handler before any page\'s own', async () => {
        // jQuery runs ready handlers in registration order, and the page's
        // handlers read XC.coin, which initPage() in xchain.js sets.
        for(const file of allPages()){
            const order = executionOrder(units(await compose(file))).map((u) => u.name);
            const boot = order.indexOf('/js/xchain.js');
            const firstInline = order.indexOf('inline script');
            assert.ok(boot >= 0, file + ' does not load xchain.js');
            assert.ok(firstInline < 0 || boot < firstInline, file + ' runs an inline script before xchain.js');
        }
    });

    it('catches a page that reads a deferred global while the parser runs it', () => {
        // The replay must be able to fail: an inline read of a deferred
        // script's function at parse time is exactly what defer breaks.
        const html = '<script src="/js/jquery.min.js"></script>'
            + '<script src="/js/xchain/detail/detail_bet_stake.js" defer></script>'
            + '<script>const wrapped = showBetDetails;</script>';
        assert.deepStrictEqual(earlyReads(html), ['inline script reads id:showBetDetails before it is defined']);
    });
});
