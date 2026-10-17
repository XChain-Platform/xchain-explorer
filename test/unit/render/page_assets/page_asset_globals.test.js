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
 * Every global a page's code can reach is provided by a script that page
 * loads. This is the guard behind the per-page asset table: a group dropped
 * from a page that still calls into it fails here, naming the read and the
 * declaration that made it.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { HTML_DIR, compose, allPages } = require('./support/compose.js');
const { closure, inlineCode, scriptSrcs } = require('./support/page_closure.js');

const TEMPLATE_SCRIPTS = scriptSrcs(fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8'));
const stripVersion = (url) => url.replace(/\?v=[0-9a-f]+$/, '');

// Run on every page whatever its own code calls: the bootstrap and the chrome
// components composed into the shell.
const ALWAYS = [
    '/js/xchain.js',
    '/js/browser_logger.js',
    '/components/nav/init.js',
    '/components/search-box/init.js',
    '/components/footer/init.js',
    '/components/theme-toggle/init.js'
];

// The bootstrap's data API runs from markup attributes, which no script scan
// sees; it is on every page by policy, and asserted here so it stays so.
const BY_POLICY = ['/js/bootstrap.bundle.min.js'];

async function reach(file){
    const html = await compose(file);
    const emitted = scriptSrcs(html).map(stripVersion);
    const fragment = scriptSrcs(await fragmentHtml(file));
    const code = inlineCode(html);
    const universe = [...new Set([...TEMPLATE_SCRIPTS, ...fragment])];
    const result = closure(code.reads, [...ALWAYS, ...fragment], universe, code.declares);
    return { emitted, result };
}

// The page's own markup, for the scripts it carries itself.
async function fragmentHtml(file){
    const own = path.join(HTML_DIR, file);
    return fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : '';
}

describe('page asset groups: every reachable global is loaded', function () {

    this.timeout(60000);

    it('resolves every global each page reads to some script', async () => {
        const bad = [];
        for(const file of allPages()){
            const { result } = await reach(file);
            if(result.unresolved.size) bad.push(file + ': ' + [...result.unresolved].join(', '));
        }
        assert.deepStrictEqual(bad, [], 'globals no script declares');
    });

    it('loads, on each page, every script that page can reach', async () => {
        const missing = [];
        for(const file of allPages()){
            const { emitted, result } = await reach(file);
            for(const [url, why] of result.files)
                if(!emitted.includes(url)) missing.push(file + ' lacks ' + url + ' (' + why + ')');
        }
        assert.deepStrictEqual(missing, [], 'reachable scripts a page does not load');
    });

    it('loads the policy scripts on every page', async () => {
        const missing = [];
        for(const file of allPages()){
            const { emitted } = await reach(file);
            BY_POLICY.filter((u) => !emitted.includes(u)).forEach((u) => missing.push(file + ' lacks ' + u));
        }
        assert.deepStrictEqual(missing, []);
    });

    it('sees through the scan: dropping a needed group is caught', async () => {
        // The guard is only as good as the closure, so prove it fails on a page
        // stripped of a library its code calls.
        const { emitted, result } = await reach('market.html');
        const stripped = emitted.filter((u) => !/chart/.test(u));
        const caught = [...result.files.keys()].filter((u) => !stripped.includes(u));
        assert.ok(caught.includes('/js/chart.umd.js'), 'a market page without Chart.js passes the guard');
        assert.ok(caught.includes('/js/xchain_charts/browser.js'));
        assert.ok(result.files.has('/js/math.min.js'));
        const block = await reach('block.html');
        assert.ok(!block.emitted.includes('/js/chart.umd.js'), 'the block page loads the chart stack again');
    });
});
