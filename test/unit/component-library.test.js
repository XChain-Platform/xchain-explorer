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
 * The extracted component library (spec M2.4).
 *
 * Ten components, and the page shell's chrome among them: the nav, the search
 * box, the theme toggle and the footer used to be 24KB of markup inlined in
 * template.html and are now composed from component templates.
 *
 * The gate on that extraction is byte-identity against a committed copy of the
 * pre-extraction shell. It has to be, because the alternative claim - "the page
 * still looks right" - is exactly what a 24KB move cannot support by eye, and
 * because the theme-parity probe hashes computed styles off these pages and
 * would report any drift here as a mysterious CSS movement much later.
 *
 * The rest is about a component being a real, declared thing rather than a
 * folder: it registers, its component.json agrees with what it registers, its
 * stylesheet reads tokens rather than literals, and its mount does the one
 * runtime job that could not be composed.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT           = path.resolve(__dirname, '..', '..');
const COMPONENT_DIR  = path.join(ROOT, 'src', 'content', 'components');
const HTML_DIR       = path.join(ROOT, 'src', 'content', 'html');
const componentTpl   = require(path.join(ROOT, 'src', 'component-templates.js'));
const XCComponents   = require(path.join(ROOT, 'src', 'content', 'js', 'components.js'));

const NAMES = fs.readdirSync(COMPONENT_DIR).filter((d) =>
    fs.statSync(path.join(COMPONENT_DIR, d)).isDirectory()).sort();

// The library the spec names, so a component quietly dropped from the tree
// fails here rather than at the moment a theme tries to override it.
const EXPECTED = [
    'chart', 'data-table', 'detail-card', 'footer', 'nav',
    'qr-card', 'search-box', 'stat-card', 'tab-panel', 'theme-toggle'
].sort();

const SOURCE = require('../helpers/content-source.js');

function loadAll(){
    SOURCE.loadComponents(NAMES);
}

describe('component library (M2.4)', function () {

    describe('the library exists as declared things', function () {

        it('ships exactly the components the spec names', function () {
            assert.deepEqual(NAMES, EXPECTED);
        });

        it('gives each one a prop table, a mount script and a stylesheet', function () {
            const missing = [];
            for(const name of NAMES)
                for(const f of ['component.json', 'init.js', 'component.css'])
                    if(!fs.existsSync(path.join(COMPONENT_DIR, name, f))) missing.push(name + '/' + f);
            assert.deepEqual(missing, [], missing.join(', '));
        });

        it('gives each one a template', function () {
            const missing = NAMES.filter((n) => !fs.existsSync(path.join(COMPONENT_DIR, n, 'template.html')));
            assert.deepEqual(missing, [], 'components with no template.html: ' + missing.join(', '));
        });

        it('registers every one of them on load', function () {
            loadAll();
            assert.deepEqual(XCComponents.names(), EXPECTED);
        });

        it('declares in component.json exactly the props each one registers', function () {
            const wrong = [];
            for(const name of NAMES){
                const declared = Object.keys(JSON.parse(
                    fs.readFileSync(path.join(COMPONENT_DIR, name, 'component.json'), 'utf8')).props).sort();
                const src = fs.readFileSync(path.join(COMPONENT_DIR, name, 'init.js'), 'utf8');
                const block = /props:\s*\{([\s\S]*?)\n        \}/.exec(src);
                if(!block){ wrong.push(name + ': no props block in init.js'); continue; }
                const registered = [...block[1].matchAll(/^\s*([a-zA-Z]+):\s*\{/gm)].map((m) => m[1]).sort();
                if(JSON.stringify(registered) !== JSON.stringify(declared))
                    wrong.push(name + ': registers [' + registered + '] but declares [' + declared + ']');
            }
            // The browser validates against register(); a component.json that
            // disagrees is documentation that lies to the theme author reading it.
            assert.deepEqual(wrong, [], wrong.join('\n'));
        });

        it('loads every component script and stylesheet from the shell', function () {
            const shell = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
            const missing = [];
            for(const name of NAMES){
                if(!shell.includes('/components/' + name + '/init.js')) missing.push(name + ' init.js');
                if(!shell.includes('/components/' + name + '/component.css')) missing.push(name + ' component.css');
            }
            assert.deepEqual(missing, [], 'component assets the shell never loads: ' + missing.join(', '));
        });

        it('serves the component directory over HTTP, or none of those tags resolve', function () {
            const explorer = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');
            const statics = /'static'\s*:\s*\[([\s\S]*?)\]/.exec(explorer);
            assert.ok(statics, 'static directory list not found');
            assert.match(statics[1], /'components'/,
                "content/components is not served, so every component script 404s and no page mounts");
        });
    });

    describe('the shell chrome extraction', function () {

        it('composes byte-for-byte the shell that shipped before the extraction', function () {
            const baseline = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'template-baseline.html'), 'utf8');
            const shell    = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
            assert.equal(componentTpl.chrome(shell), baseline,
                'the composed shell differs from the pre-extraction one; every page in the '
                + 'explorer is downstream of this');
        });

        it('left the shell holding slots rather than markup', function () {
            const shell = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
            assert.match(shell, /\{NAV\}/);
            assert.match(shell, /\{FOOTER\}/);
            assert.equal(/<nav class="navbar/.test(shell), false, 'the nav is still inlined in the shell');
            assert.equal(/<footer class="footer/.test(shell), false, 'the footer is still inlined in the shell');
        });

        it('nests the search box and the theme toggle inside the nav template', function () {
            const nav = componentTpl.template('nav');
            assert.match(nav, /\{SEARCH_BOX\}/);
            assert.match(nav, /\{THEME_TOGGLE\}/);
            const composed = componentTpl.render('nav', {
                SEARCH_BOX:   componentTpl.render('search-box', {}),
                THEME_TOGGLE: componentTpl.render('theme-toggle', {})
            });
            assert.match(composed, /id="mainmenu-search"/);
            assert.match(composed, /id="btn-dark-mode"/);
            assert.equal(composed.includes('{SEARCH_BOX}'), false);
        });

        it('leaves {PLATFORM_SWITCHER} for the shell to fill, not the component layer', function () {
            const composed = componentTpl.chrome(fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8'));
            assert.match(composed, /\{PLATFORM_SWITCHER\}/,
                'the cross-site switcher is filled from platform_links.js at request time');
        });

        it('substitutes a slot value literally, never as a $-sequence', function () {
            // $&, $1 and $' are capture-group references in a replacement string,
            // and the nav markup carries them.
            const out = componentTpl.render('search-box', {});
            assert.equal(out.includes('$'), false);
            const tricky = componentTpl.render('nav', { SEARCH_BOX: "$& $1 $' X", THEME_TOGGLE: '' });
            assert.match(tricky, /\$& \$1 \$' X/);
        });

        it('refuses a component name that climbs out of the component directory', function () {
            assert.throws(() => componentTpl.template('../../js/xchain'), /escapes the component directory|ENOENT/);
        });
    });

    describe('the mounts that could not be composed', function () {

        function realm(html){
            const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>',
                { runScripts: 'outside-only' });
            global.document = dom.window.document;
            return dom;
        }

        afterEach(function(){ delete global.document; });

        beforeEach(function(){ loadAll(); });

        it('footer writes the year at MOUNT, so a cached page cannot go stale on New Year', function () {
            realm('<footer id="f"><span id="copyright-year"></span></footer>');
            const res = XCComponents.mount('f', 'footer', {});
            assert.equal(res.ok, true, res.errors.join('; '));
            assert.equal(document.getElementById('copyright-year').textContent,
                String(new Date().getFullYear()));
        });

        it('search-box fills the hidden coin field, which decides WHICH network is searched', function () {
            realm('<form id="s"><input type="hidden" id="coin-search"></form>');
            const res = XCComponents.mount('s', 'search-box', { coin: 'RDOGE' });
            assert.equal(res.ok, true, res.errors.join('; '));
            assert.equal(document.getElementById('coin-search').value, 'RDOGE');
        });

        it('search-box falls back to the page context when no coin prop is given', function () {
            realm('<form id="s"><input type="hidden" id="coin-search"></form>');
            XCComponents.mount('s', 'search-box', {}, { coin: 'TBTC' });
            assert.equal(document.getElementById('coin-search').value, 'TBTC');
        });

        it('theme-toggle applies a mode through the shipped updateTheme', function () {
            realm('<ul id="t"></ul>');
            const applied = [];
            global.updateTheme = (m) => applied.push(m);
            try {
                const res = XCComponents.mount('t', 'theme-toggle', { mode: 'dark' });
                assert.equal(res.ok, true, res.errors.join('; '));
                assert.deepEqual(applied, ['dark']);
            } finally { delete global.updateTheme; }
        });

        it('theme-toggle refuses a mode it does not recognise, defaulting to light', function () {
            realm('<ul id="t"></ul>');
            const applied = [];
            global.updateTheme = (m) => applied.push(m);
            try {
                XCComponents.mount('t', 'theme-toggle', { mode: 'chartreuse' });
                assert.deepEqual(applied, ['light']);
            } finally { delete global.updateTheme; }
        });

        it('tab-panel reorders the tab buttons to match the config', function () {
            realm('<div id="p"></div>'
                + '<ul data-xc-tabs="p">'
                + '<li data-xc-tab="a">A</li><li data-xc-tab="b">B</li><li data-xc-tab="c">C</li>'
                + '</ul>');
            const res = XCComponents.mount('p', 'tab-panel', {
                id: 'p',
                tabs: [{ key: 'a' }, { key: 'b' }, { key: 'c', order: 0 }]
            });
            assert.equal(res.ok, true, res.errors.join('; '));
            const order = [...document.querySelectorAll('[data-xc-tabs="p"] [data-xc-tab]')]
                .map((n) => n.getAttribute('data-xc-tab'));
            assert.deepEqual(order, ['c', 'a', 'b']);
            assert.equal(res.result.active, 'c', 'the first VISIBLE tab is the default active one');
        });

        it('tab-panel skips a hidden tab when choosing the active one', function () {
            realm('<div id="p"></div>'
                + '<ul data-xc-tabs="p"><li data-xc-tab="a">A</li><li data-xc-tab="b">B</li></ul>');
            const res = XCComponents.mount('p', 'tab-panel', {
                id: 'p', tabs: [{ key: 'a', hidden: true }, { key: 'b' }]
            });
            assert.equal(res.result.active, 'b');
            assert.deepEqual(res.result.tabs, ['b']);
        });

        it('stat-card reveals its card and applies the row order', function () {
            realm('<div id="c" class="d-none"><table><tbody>'
                + '<tr id="r0"><th>A</th><td></td></tr>'
                + '<tr id="r1"><th>B</th><td></td></tr>'
                + '</tbody></table></div>');
            const res = XCComponents.mount('c', 'stat-card', {
                id: 'c', title: 'Stats', rows: [{ label: 'A' }, { label: 'B', order: 0 }]
            });
            assert.equal(res.ok, true, res.errors.join('; '));
            assert.equal(document.getElementById('c').classList.contains('d-none'), false);
            assert.deepEqual([...document.querySelectorAll('#c tbody tr')].map((r) => r.id), ['r1', 'r0']);
        });

        it('qr-card refuses loudly when the QR plugin is not loaded, instead of an empty square', function () {
            realm('<div id="q"></div>');
            const res = XCComponents.mount('q', 'qr-card', { id: 'q', text: 'addr' });
            assert.equal(res.ok, false);
            assert.match(res.errors[0], /jquery\.qrcode is not loaded/);
            assert.match(document.getElementById('q').textContent, /qrcode/);
        });

        it('chart defers rather than failing when the chart layer has not loaded yet', function () {
            realm('<canvas id="ch"></canvas>');
            const res = XCComponents.mount('ch', 'chart', { id: 'ch', kind: 'price' });
            assert.equal(res.ok, true);
            assert.equal(res.result.deferred, true);
        });
    });
});
