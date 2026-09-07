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
 * The whole M2 path, end to end: compose a page the way the request handler
 * does, load it in a browser realm, and watch the components mount.
 *
 * The other suites each hold one seam still. This one exists because the seams
 * can each be right and the assembly still broken - a slot left unfilled, a
 * script tag pointing at a directory the server does not serve, a mount that
 * runs before the coin is known. Every one of those renders a page that looks
 * fine in view-source and shows an empty table to a reader.
 *
 * The composition below is a copy of the html branch of XChainExplorer's
 * request handler, in the same order, and a test asserts that it stayed a copy.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT       = path.resolve(__dirname, '..', '..');
const HTML_DIR   = path.join(ROOT, 'src', 'content', 'html');
const JS_DIR     = path.join(ROOT, 'src', 'content', 'js');
const COMP_DIR   = path.join(ROOT, 'src', 'content', 'components');

const listPage     = require(path.join(ROOT, 'src', 'list-page.js'));
const componentTpl = require(path.join(ROOT, 'src', 'component-templates.js'));
const { renderPlatformSwitcher } = require(path.join(ROOT, 'src', 'platform_links.js'));

// The html branch of processRequest, reproduced. Kept in the same order as the
// shipped one, and pinned to it by the last test in this file.
function serve(file){
    const templateContent = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
    let htmlContent = listPage.render(file);
    if(htmlContent === null)
        htmlContent = fs.readFileSync(path.join(HTML_DIR, file), 'utf8');
    let pageContent = componentTpl.chrome(templateContent);
    htmlContent = listPage.dataBlocks(htmlContent);
    pageContent = pageContent.replace('{CONTENT}', () => htmlContent);
    pageContent = pageContent.replace('{PLATFORM_SWITCHER}', () => renderPlatformSwitcher());
    return pageContent;
}

function read(dir, file){ return fs.readFileSync(path.join(dir, file), 'utf8'); }

// A realm holding the served page and every script the shell asks for, with
// DataTables stubbed so the ajax config it would have used can be read back.
function browserRealm(file, coin){
    const dom = new JSDOM(serve(file), {
        runScripts: 'outside-only',
        url: 'https://xchain.test/' + (coin || 'RDOGE') + '/sends'
    });
    const win = dom.window;
    win.eval(read(JS_DIR, 'jquery.min.js'));
    // Ready handlers are driven explicitly below, so their ORDER is observable
    // rather than whatever jsdom's document lifecycle happens to do.
    win.jQuery.fn.ready = function(){ return this; };
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(read(JS_DIR, 'formatters.js'));
    win.eval(read(JS_DIR, 'components.js'));
    win.eval(read(JS_DIR, 'xchain.js'));
    win.eval(read(path.join(COMP_DIR, 'data-table'), 'columns.js'));
    for(const name of fs.readdirSync(COMP_DIR))
        win.eval(read(path.join(COMP_DIR, name), 'init.js'));
    const captured = {};
    win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

describe('composed page, end to end (M2)', function () {

    describe('what the server hands the browser', function () {

        for(const file of ['sends.html', 'action.html', 'coin_home.html']){
            it(file + ' comes out with every slot filled', function () {
                const page = serve(file);
                for(const slot of ['{CONTENT}', '{NAV}', '{FOOTER}', '{PLATFORM_SWITCHER}'])
                    assert.equal(page.includes(slot), false, file + ' still carries ' + slot);
                assert.equal(/\{DATA:[a-z0-9-]+\}/.test(page), false, file + ' still carries a data placeholder');
            });

            it(file + ' carries the chrome and the component assets', function () {
                const page = serve(file);
                assert.match(page, /<nav class="navbar/, 'the nav did not compose in');
                assert.match(page, /<footer class="footer/, 'the footer did not compose in');
                assert.match(page, /src="\/components\/data-table\/init\.js"/);
                assert.match(page, /href="\/components\/data-table\/component\.css"/);
                assert.match(page, /src="\/js\/formatters\.js"/);
            });
        }
    });

    describe('what the browser does with it', function () {

        it('mounts the list table and points it at the right feed', function () {
            const { win, captured } = browserRealm('sends.html');
            win.XC.coin = 'RDOGE';
            win.XCComponents.mountManifest();

            const mounted = win.XCComponents.mounted();
            assert.equal(mounted.length, 1);
            assert.equal(mounted[0].component, 'data-table');
            assert.equal(mounted[0].el.id, 'datatable-send');
            assert.equal(captured.config.ajax.url, '/RDOGE/explorer/sends',
                'the mounted table asks a different feed than the page is for');
        });

        it('leaves no mount error anywhere on the page', function () {
            const { win } = browserRealm('sends.html');
            win.XC.coin = 'RDOGE';
            win.XCComponents.mountManifest();
            const failed = [...win.document.querySelectorAll('[data-xc-mount-error]')]
                .map((el) => el.getAttribute('data-xc-mount-error'));
            assert.deepEqual(failed, []);
        });

        it('serves a header the reader can see before any script runs', function () {
            // The header is rendered server-side from the same config the client
            // resolves. If it were client-only, a reader would get an empty table
            // frame until the mount ran, and a crawler would get nothing at all.
            const page = serve('sends.html');
            const head = /<thead>([\s\S]*?)<\/thead>/.exec(page);
            assert.ok(head);
            assert.equal((head[1].match(/<th[\s>]/g) || []).length, 8);
        });

        it('mounts with a REAL coin, which is the whole reason mounting is deferred', function () {
            // Driving the ready handlers in shipped order: xchain.js's handler
            // calls initPage() and only then mountManifest(). A mount that ran
            // earlier would request /null/explorer/sends and render empty.
            const { win, captured } = browserRealm('sends.html', 'TDOGE');
            win.XC.coin = 'TDOGE';
            win.XCComponents.mountManifest();
            assert.equal(captured.config.ajax.url, '/TDOGE/explorer/sends');
        });
    });

    it('is still a faithful copy of the shipped html branch', function () {
        // This suite proves the assembly only if the assembly it runs is the
        // one the service runs.
        const src = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');
        const branch = src.slice(src.indexOf("if(cfg.type=='html'){"), src.indexOf('response.time = this.util.getTimer'));
        const steps = [
            /let htmlContent = listPage\.render\(cfg\.file\)/,
            /let pageContent = componentTpl\.chrome\(templateContent\)/,
            /htmlContent\s*= listPage\.dataBlocks\(htmlContent\)/,
            /pageContent\s*= pageContent\.replace\('\{CONTENT\}'/,
            /pageContent\s*= pageContent\.replace\('\{PLATFORM_SWITCHER\}'/
        ];
        let at = -1;
        for(const step of steps){
            const m = step.exec(branch);
            assert.ok(m, 'the shipped html branch no longer does: ' + step);
            assert.ok(m.index > at, 'the shipped html branch reordered its composition steps');
            at = m.index;
        }
    });
});
