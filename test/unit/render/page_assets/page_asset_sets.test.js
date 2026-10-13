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
 * The shell assets each page is sent with, pinned page by page in
 * support/expected_assets.json: every page gets `core`, plus its own list.
 * A change to page-assets.json that adds or drops a library on any page shows
 * up here as a named diff, in template order.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { HTML_DIR, compose, fragments, listPage } = require('./support/compose.js');
const { scriptSrcs, styleHrefs } = require('./support/page_closure.js');
const EXPECTED = require('./support/expected_assets.json');

const TEMPLATE = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
const MANAGED = new Set([...scriptSrcs(TEMPLATE), ...styleHrefs(TEMPLATE)]);
const stripVersion = (url) => url.replace(/\?v=[0-9a-f]+$/, '');

// Shell assets as sent: stylesheets then scripts, each in document order.
async function shellAssets(file){
    const html = await compose(file);
    return [...styleHrefs(html), ...scriptSrcs(html)].map(stripVersion).filter((u) => MANAGED.has(u));
}

function expectedFor(key){
    const extra = EXPECTED.pages[key];
    assert.ok(extra, 'no pinned asset list for ' + key);
    const want = new Set([...EXPECTED.core, ...extra]);
    const order = [...styleHrefs(TEMPLATE), ...scriptSrcs(TEMPLATE)];
    return order.filter((u) => want.has(u));
}

describe('page asset groups: what each page is sent', function () {

    this.timeout(60000);

    it('pins every page fragment', () => {
        const pinned = Object.keys(EXPECTED.pages).filter((k) => k !== 'list page');
        assert.deepStrictEqual(pinned.sort(), fragments());
    });

    for(const file of fragments()){
        it(file, async () => {
            assert.deepStrictEqual(await shellAssets(file), expectedFor(file));
        });
    }

    it('sends every list page the same assets', async () => {
        const want = expectedFor('list page');
        const wrong = [];
        for(const file of listPage.pages()){
            const got = await shellAssets(file);
            if(JSON.stringify(got) !== JSON.stringify(want)) wrong.push(file);
        }
        assert.deepStrictEqual(wrong, []);
    });

    it('keeps the heavy libraries off the pages that never call them', async () => {
        const heavy = ['/js/math.min.js', '/js/chart.umd.js', '/js/jquery.dataTables.js', '/js/highlight.min.js', '/css/swagger-ui.css'];
        for(const file of ['home.html', 'about.html', 'anchor.html', 'validator.html']){
            const got = await shellAssets(file);
            assert.deepStrictEqual(heavy.filter((u) => got.includes(u)), [], file);
        }
    });
});
