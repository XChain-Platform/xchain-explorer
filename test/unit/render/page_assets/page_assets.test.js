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
 * The asset-group table and the selector that applies it: every template
 * asset belongs to one group, every page declares its groups, and what the
 * selector emits still gets a content version.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { ROOT, HTML_DIR, compose, fragments, listPage } = require('./support/compose.js');
const { scriptSrcs, styleHrefs } = require('./support/page_closure.js');
const pageAssets = require(path.join(ROOT, 'src', 'render', 'page_assets.js'));

const TEMPLATE = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(pageAssets.MANIFEST, 'utf8'));
const TEMPLATE_ASSETS = [...scriptSrcs(TEMPLATE), ...styleHrefs(TEMPLATE)];
const stripVersion = (url) => url.replace(/\?v=[0-9a-f]+$/, '');

describe('page asset groups: the table', function () {

    it('puts every template asset in exactly one group, and names nothing the template lacks', () => {
        const seen = new Map();
        for(const [name, group] of Object.entries(MANIFEST.groups))
            for(const url of group.assets) seen.set(url, (seen.get(url) || []).concat(name));
        const twice = [...seen].filter(([, g]) => g.length > 1).map(([u, g]) => u + ' in ' + g.join(', '));
        const loose = TEMPLATE_ASSETS.filter((u) => !seen.has(u));
        const ghost = [...seen.keys()].filter((u) => !TEMPLATE_ASSETS.includes(u));
        assert.deepStrictEqual(twice, [], 'assets in more than one group');
        assert.deepStrictEqual(loose, [], 'template assets no group owns, so every page drops them');
        assert.deepStrictEqual(ghost, [], 'group assets the template never lists');
    });

    it('declares groups for every page fragment, and only groups that exist', () => {
        const undeclared = fragments().filter((f) => pageAssets.declared(f, false) === null);
        assert.deepStrictEqual(undeclared, [], 'pages with no entry in page-assets.json load every group');
        const names = Object.keys(MANIFEST.groups);
        const pages = Object.entries(MANIFEST.pages).concat([['list page', MANIFEST.listPage]]);
        const unknown = pages.flatMap(([p, groups]) => groups.filter((g) => !names.includes(g)).map((g) => p + ': ' + g));
        assert.deepStrictEqual(unknown, []);
        const stale = Object.keys(MANIFEST.pages).filter((p) => !fragments().includes(p));
        assert.deepStrictEqual(stale, [], 'entries for pages that no longer exist');
    });

    it('keeps the blocking scripts in core and in template order', () => {
        const core = MANIFEST.groups.core.assets;
        assert.deepStrictEqual(MANIFEST.blocking.filter((u) => !core.includes(u)), []);
        const order = scriptSrcs(TEMPLATE);
        const at = MANIFEST.blocking.map((u) => order.indexOf(u));
        assert.deepStrictEqual(at, [...at].sort((a, b) => a - b));
    });

    it('gives a page with no entry every group, so it can only lose speed', () => {
        const all = pageAssets.assetsFor('no-such-page.html', false);
        assert.deepStrictEqual(TEMPLATE_ASSETS.filter((u) => !all.has(u)), []);
    });

    it('follows requires, and always includes core', () => {
        const groups = pageAssets.groupsFor('market.html', false);
        for(const g of ['core', 'market', 'datatable', 'charts', 'math']) assert.ok(groups.has(g), g);
        assert.deepStrictEqual([...pageAssets.groupsFor(listPage.pages()[0], true)].sort(),
            ['core', 'data-table', 'datatable', 'math']);
    });
});

describe('page asset groups: the selector', function () {

    const shell = '<link type="text/css" rel="stylesheet" href="/css/swagger-ui.css" />\n'
        + '    <script type="text/javascript" src="/js/math.min.js"></script>\n'
        + '    <script type="text/javascript" src="/js/xchain.js"></script>\n'
        + '    <script type="text/javascript" src="/js/numeral.js"></script>\n'
        + '<script src="/js/own_page_script.js" charset="UTF-8"> </script>\n';

    it('drops the grouped assets a page does not load, line and all', () => {
        const out = pageAssets.selectAssets(shell, 'about.html', false);
        assert.ok(!out.includes('swagger-ui.css'));
        assert.ok(!out.includes('math.min.js'));
        assert.ok(!/\n\s*\n/.test(out), 'a dropped tag left a blank line');
    });

    it('defers every script but the blocking chain, a fragment\'s own scripts included', () => {
        const out = pageAssets.selectAssets(shell, 'about.html', false);
        assert.match(out, /src="\/js\/xchain\.js"><\/script>/);
        assert.match(out, /src="\/js\/numeral\.js" defer><\/script>/);
        assert.match(out, /src="\/js\/own_page_script\.js" charset="UTF-8" defer> <\/script>/);
        assert.strictEqual(pageAssets.selectAssets(out, 'about.html', false), out, 'a second pass adds a second defer');
    });
});

describe('page asset groups: the page as sent', function () {

    this.timeout(20000);

    it('versions every emitted script and stylesheet the way it did before', async () => {
        const html = await compose('block.html');
        const local = [...html.matchAll(/(?:src|href)="(\/(?:js|css|components)\/[^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
        assert.ok(local.length > 20);
        assert.deepStrictEqual(local.filter((u) => !/\?v=[0-9a-f]{10}$/.test(u)), []);
        assert.match(html, /src="\/js\/jquery\.dataTables\.js\?v=[0-9a-f]{10}" defer>/);
        assert.match(html, /src="\/js\/jquery\.min\.js\?v=[0-9a-f]{10}"><\/script>/);
    });

    it('leaves the theme stylesheet link byte-identical, so the theme resolver still finds it', async () => {
        const tag = TEMPLATE.match(/<link[^>]*\/themes\/classic\/tokens\.css"[^>]*>/)[0];
        for(const file of ['home.html', 'block.html', listPage.pages()[0]])
            assert.ok((await compose(file)).includes(tag), file);
    });

    it('emits assets in template order', async () => {
        const order = TEMPLATE_ASSETS;
        for(const file of ['market.html', 'action.html', listPage.pages()[0]]){
            const html = await compose(file);
            const emitted = [...scriptSrcs(html), ...styleHrefs(html)].map(stripVersion).filter((u) => order.includes(u));
            const at = emitted.filter((u) => u.endsWith('.js')).map((u) => order.indexOf(u));
            assert.deepStrictEqual(at, [...at].sort((a, b) => a - b), file);
        }
    });
});
