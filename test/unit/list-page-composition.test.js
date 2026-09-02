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
 * The shared list-page composition (spec M2.3).
 *
 * 76 page fragments were deleted and replaced by 76 config entries and one
 * layout. The only defensible way to make that claim is to keep a copy of what
 * every one of those pages served the day before, and compare - which is what
 * test/fixtures/list-page-baseline.json is for.
 *
 * Two comparisons, because the page has two halves and they can fail
 * differently.
 *
 * The MARKUP must be byte-identical. Not equivalent, not visually the same:
 * the theme-parity probe hashes computed styles off these pages, so a moved
 * class or a changed indent shows up there as a false movement weeks later.
 * The only tolerated difference is trailing whitespace between the markup and
 * the script block, which cannot render.
 *
 * The SEO strings must evaluate the same. Those moved from an inline
 * expression to config, and re-quoting a string is exactly where an escape
 * gets lost, so the comparison drives both versions of the ready block in a
 * jsdom realm and compares the values XC.pageInfo ends up holding.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT     = path.resolve(__dirname, '..', '..');
const listPage = require(path.join(ROOT, 'src', 'list-page.js'));
const SOURCE   = require('../helpers/content-source.js');

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'list-page-baseline.json'), 'utf8'));
const HTML_DIR = path.join(ROOT, 'src', 'content', 'html');
const EXPLORER = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');

// Everything before the first <script> is what a reader sees.
function markup(src){
    return src.slice(0, src.indexOf('<script')).replace(/\s+$/, '');
}

// Run a page's $(document).ready body against a stub XC and return the
// pageInfo it produced. Both the shipped fragment and the composed page are
// driven through this, so the comparison is of VALUES, not of source text.
function pageInfoOf(src){
    const body = /<script type="text\/javascript">\n\$\(document\)\.ready\(function\(\) \{\n([\s\S]*?)\n\}\);\n<\/script>/.exec(src);
    assert.ok(body, 'no ready block found in the page');
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const win = dom.window;
    win.eval('var XC = { coin: "RDOGE", name: "Dogecoin", network: "regtest", pageInfo: {} };'
        + 'function updatePageInfo(){}'
        + 'function loadDatatablesData(){}');
    win.eval('(function(){' + body[1] + '})();');
    return win.XC.pageInfo;
}

describe('list-page composition (M2.3)', function () {

    const pages = listPage.pages();

    it('collapsed the bulk of the list pages, not a token few', function () {
        assert.ok(pages.length >= 70, 'only ' + pages.length + ' pages are composed');
    });

    it('serves markup byte-identical to the page it replaced, on every one', function () {
        const wrong = [];
        for(const file of pages){
            if(markup(listPage.render(file)) !== markup(BASELINE[file])) wrong.push(file);
        }
        assert.deepEqual(wrong, [],
            'composed pages whose markup moved:\n  ' + wrong.join('\n  '));
    });

    it('produces the same title, description and canonical URL on every one', function () {
        const wrong = [];
        for(const file of pages){
            const was = pageInfoOf(BASELINE[file]);
            const now = pageInfoOf(listPage.render(file));
            for(const key of ['title', 'description', 'canonical'])
                if(was[key] !== now[key])
                    wrong.push(file + '.' + key + ':\n    was ' + JSON.stringify(was[key])
                        + '\n    now ' + JSON.stringify(now[key]));
        }
        assert.deepEqual(wrong, [], 'pageInfo that changed value:\n  ' + wrong.join('\n  '));
    });

    it('still calls updatePageInfo, so the meta tags are actually rewritten', function () {
        for(const file of pages)
            assert.match(listPage.render(file), /updatePageInfo\(\);/, file + ' stopped updating its meta tags');
    });

    describe('the mount manifest each page ships', function () {

        it('names one data-table per page, on the table the page renders', function () {
            for(const file of pages){
                const cfg = listPage.config(file);
                const m = listPage.manifest(cfg);
                assert.equal(m.length, 1, file + ' should mount exactly one component');
                assert.equal(m[0].component, 'data-table');
                assert.equal(m[0].el, 'datatable-' + cfg.action);
                assert.match(listPage.render(file), new RegExp('id="datatable-' + cfg.action + '"'),
                    file + ' mounts a table it does not render');
            }
        });

        it('carries the same column config the header was generated from', function () {
            for(const file of pages){
                const cfg = listPage.config(file);
                assert.deepEqual(listPage.manifest(cfg)[0].props.columns, cfg.columns,
                    file + ': the client would resolve a different column set than the server rendered');
            }
        });

        it('validates against the data-table prop table', function () {
            const XCComponents = SOURCE.loadComponents(['data-table']);
            const bad = [];
            for(const file of pages){
                const entry = listPage.manifest(listPage.config(file))[0];
                const res = XCComponents.validate('data-table', entry.props);
                if(!res.ok) bad.push(file + ': ' + res.errors.join('; '));
            }
            assert.deepEqual(bad, [], 'manifests the runtime would refuse to mount:\n  ' + bad.join('\n  '));
        });

        it('ships as JSON data, not as code, and cannot close its own script element', function () {
            for(const file of pages){
                const block = /<script type="application\/json" id="xc-mount-manifest">([\s\S]*?)<\/script>/
                    .exec(listPage.render(file));
                assert.ok(block, file + ' has no manifest block');
                assert.equal(block[1].includes('<'), false,
                    file + ': an unescaped "<" in the manifest can close the script element early');
                assert.doesNotThrow(() => JSON.parse(block[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')));
            }
        });
    });

    describe('routing', function () {

        function htmlRoutes(){
            const table = EXPLORER.slice(EXPLORER.indexOf("'html' : {"), EXPLORER.indexOf('setupRoutes'));
            return [...table.matchAll(/'([^']+)'\s*:\s*'([a-z0-9_]+\.html)'/g)].map((m) => ({ route: m[1], file: m[2] }));
        }

        it('leaves the url table untouched: every route still names its old fragment', function () {
            const routes = htmlRoutes();
            assert.ok(routes.length > 100, 'route table extraction looks broken');
            const unresolved = routes.filter((r) => !SOURCE.pageExists(r.file));
            assert.deepEqual(unresolved.map((r) => r.route + ' -> ' + r.file), [],
                'routes that resolve to neither the composer nor a fragment');
        });

        it('deleted every fragment the composer took over', function () {
            const strays = pages.filter((f) => fs.existsSync(path.join(HTML_DIR, f)));
            assert.deepEqual(strays, [],
                'fragments left on disk for composed routes; the next reader will edit one '
                + 'and see no effect:\n  ' + strays.join('\n  '));
        });

        it('is wired into the request path ahead of the filesystem read', function () {
            assert.match(EXPLORER, /listPage\.render\(cfg\.file\)/,
                'XChainExplorer no longer asks the composer, so every collapsed route 404s in effect');
        });

        it('falls back to a fragment for a page the composer does not own', function () {
            assert.equal(listPage.render('action.html'), null,
                'action.html is not a plain list page and must not be composed');
            assert.equal(listPage.has('coin_home.html'), false);
        });
    });

    describe('escaping in the composed script block', function () {

        it('cannot be closed early by a value containing </script>', function () {
            // Repo-owned strings today. A composer that is only safe for its
            // current inputs is a trap for whoever adds the next page.
            const out = listPage.dataBlocks('<script type="application/json">{DATA:list-pages}</script>');
            assert.equal(out.includes('</script>{'), false);
            const inner = /<script type="application\/json">([\s\S]*)<\/script>/.exec(out)[1];
            assert.equal(inner.includes('<'), false);
            assert.equal(inner.includes('>'), false);
        });

        it('answers an unknown data name loudly, with an empty object rather than the placeholder', function () {
            const errors = [];
            const real = console.error;
            console.error = (m) => errors.push(String(m));
            let out;
            try { out = listPage.dataBlocks('x{DATA:nope}y'); } finally { console.error = real; }
            assert.equal(out, 'x{}y', 'rendering the literal placeholder to a visitor is worse than an empty config');
            assert.match(errors[0], /no layout data file for nope/);
        });

        it('leaves a page with no data placeholder untouched', function () {
            assert.equal(listPage.dataBlocks('<p>plain</p>'), '<p>plain</p>');
        });
    });
});
