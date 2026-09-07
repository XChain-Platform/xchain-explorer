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
 * The data-table component: config-driven columns (spec M2.2).
 *
 * Three separate claims, each with its own way of being wrong.
 *
 * GENERATION. Every <thead> the explorer serves is now produced from a column
 * config instead of typed into a page. The gate is byte-identity against a
 * committed copy of the 76 hand-written pages as they stood before the
 * collapse: not "the columns look right", but "these are the same bytes".
 *
 * ORDERING. The reason config-driven columns are worth having is that a theme
 * can resequence or drop one. The dangerous version of that is reordering the
 * DATA rather than the presentation: the /explorer feeds return positional
 * arrays and createdRow writes into cell N for field N, so a config applied to
 * the array would silently move every value under a different heading. These
 * cases pin the permutation to the DOM, after the row is filled, header and
 * body by the same map.
 *
 * PRESERVATION. The paging, the offset cursor and the per-page-length memory
 * were not rewritten, and the cases below drive loadDatatablesData with a
 * stubbed DataTables to prove the component did not disturb them.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT     = path.resolve(__dirname, '..', '..');
const COLUMNS  = require(path.join(ROOT, 'src', 'content', 'components', 'data-table', 'columns.js'));
const listPage = require(path.join(ROOT, 'src', 'list-page.js'));
const SOURCE   = require('../helpers/content-source.js');

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'list-page-baseline.json'), 'utf8'));

const COMPONENT_DIR = path.join(ROOT, 'src', 'content', 'components', 'data-table');
const JQUERY  = fs.readFileSync(path.join(ROOT, 'src', 'content', 'js', 'jquery.min.js'), 'utf8');

// The one place the composed markup DIFFERS from the page it replaced, named
// here rather than tolerated by a loose comparison.
const KNOWN_FIXES = {
    'sweeps.html': 'the loading row spanned 10 of its 11 columns; the component derives '
        + 'the colspan from the rendered column count, so it cannot be short again'
};

describe('data-table: config-driven columns (M2.2)', function () {

    describe('generated <thead> against the pre-component pages', function () {

        it('reproduces every shipped <thead> byte for byte', function () {
            const wrong = [];
            for(const file of listPage.pages()){
                const cfg = listPage.config(file);
                const original = /<tr class="info">\n([\s\S]*?)\n                    <\/tr>/.exec(BASELINE[file]);
                assert.ok(original, file + ' baseline has no header row');
                const generated = COLUMNS.renderThead(cfg.columns);
                if(generated !== original[1]) wrong.push(file);
            }
            assert.deepEqual(wrong, [], 'pages whose generated header is not the shipped one: ' + wrong.join(', '));
        });

        it('covers every list page, not a handful', function () {
            assert.ok(listPage.pages().length >= 70,
                'only ' + listPage.pages().length + ' pages are config-driven; the collapse regressed');
        });

        it('keeps a bare <th> bare and an empty class attribute empty', function () {
            // Both forms ship today. `cls` absent and `cls: ""` are different
            // markup, and collapsing them would move bytes on ~30 pages.
            assert.equal(COLUMNS.renderTh({ label: 'X' }).trim(), '<th>X</th>');
            assert.equal(COLUMNS.renderTh({ label: 'X', cls: '' }).trim(), '<th class="">X</th>');
            assert.equal(COLUMNS.renderTh({ label: '', cls: 'view' }).trim(), '<th class="view"></th>');
        });

        it('derives the loading-row colspan from the RENDERED column count', function () {
            const cols = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
            assert.match(COLUMNS.renderLoadingRow(cols, 'Loading...'), /colspan="3"/);
            assert.match(COLUMNS.renderLoadingRow([{ label: 'a' }, { hidden: true }], 'x'), /colspan="1"/);
        });

        it('fixes the one page whose shipped colspan was short of its columns', function () {
            const cfg = listPage.config('sweeps.html');
            assert.equal(cfg.columns.length, 11, KNOWN_FIXES['sweeps.html']);
            assert.match(BASELINE['sweeps.html'], /colspan="11"/,
                'the baseline should carry the corrected colspan; see KNOWN_FIXES');
            assert.match(listPage.render('sweeps.html'), /colspan="11"/);
        });
    });

    describe('a theme resequencing or dropping a column', function () {

        it('renders the header in the configured order', function () {
            const cols = [{ label: 'A' }, { label: 'B' }, { label: 'C', order: 0 }];
            assert.deepEqual(
                COLUMNS.renderThead(cols).split('\n').map((l) => l.trim()),
                ['<th>C</th>', '<th>A</th>', '<th>B</th>']);
        });

        it('omits a hidden column from the header', function () {
            const cols = [{ label: 'A' }, { label: 'B', hidden: true }, { label: 'C' }];
            assert.deepEqual(
                COLUMNS.renderThead(cols).split('\n').map((l) => l.trim()),
                ['<th>A</th>', '<th>C</th>']);
        });

        it('knows when no permutation is needed, so the classic theme pays nothing', function () {
            assert.equal(COLUMNS.needsPermutation([{ label: 'a' }, { label: 'b' }]), false);
            assert.equal(COLUMNS.needsPermutation([{ label: 'a' }, { label: 'b', order: 0 }]), true);
            assert.equal(COLUMNS.needsPermutation([{ label: 'a', hidden: true }]), true);
        });

        it('permutes the DRAWN cells, header and body by the same map', function () {
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<table id="t"><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>'
                + '<tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>'
                + '</body></html>', { runScripts: 'outside-only' });
            const win = dom.window;
            win.XCComponents = require(path.join(ROOT, 'src', 'content', 'js', 'components.js'));
            win.XCDataTableColumns = COLUMNS;
            const init = require(path.join(COMPONENT_DIR, 'init.js'));
            const table = win.document.getElementById('t');

            const cols = [{ label: 'A' }, { label: 'B' }, { label: 'C', order: 0 }];
            init.permuteTable(table, cols);

            const heads = [...table.querySelectorAll('thead th')].map((c) => c.textContent);
            const cells = [...table.querySelectorAll('tbody td')].map((c) => c.textContent);
            assert.deepEqual(heads, ['C', 'A', 'B']);
            assert.deepEqual(cells, ['3', '1', '2'],
                'the body must follow the same map as the header, or every value is relabelled');
        });

        it('does not permute a row twice when the table is redrawn', function () {
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<table id="t"><thead><tr><th>A</th><th>B</th></tr></thead>'
                + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
                + '</body></html>', { runScripts: 'outside-only' });
            const win = dom.window;
            win.XCComponents = require(path.join(ROOT, 'src', 'content', 'js', 'components.js'));
            win.XCDataTableColumns = COLUMNS;
            const init = require(path.join(COMPONENT_DIR, 'init.js'));
            const table = win.document.getElementById('t');
            const cols = [{ label: 'A' }, { label: 'B', order: 0 }];
            init.permuteTable(table, cols);
            init.permuteTable(table, cols);
            assert.deepEqual([...table.querySelectorAll('thead th')].map((c) => c.textContent), ['B', 'A']);
            assert.deepEqual([...table.querySelectorAll('tbody td')].map((c) => c.textContent), ['2', '1'],
                'a second pass over an already-permuted row would undo the first');
        });

        it('leaves the one-cell placeholder row alone', function () {
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<table id="t"><thead><tr><th>A</th><th>B</th></tr></thead>'
                + '<tbody><tr><td colspan="2">Loading...</td></tr></tbody></table>'
                + '</body></html>', { runScripts: 'outside-only' });
            const win = dom.window;
            win.XCComponents = require(path.join(ROOT, 'src', 'content', 'js', 'components.js'));
            win.XCDataTableColumns = COLUMNS;
            const init = require(path.join(COMPONENT_DIR, 'init.js'));
            const table = win.document.getElementById('t');
            init.permuteTable(table, [{ label: 'A' }, { label: 'B', order: 0 }]);
            assert.equal(table.querySelectorAll('tbody td').length, 1);
            assert.equal(table.querySelector('tbody td').textContent, 'Loading...');
        });
    });

    describe('paging, offsets and per-page length survive the component seam', function () {

        // One realm with the shipped client and a stubbed dataTable(), so the
        // real loadDatatablesData config can be inspected.
        function boot(){
            const dom = new JSDOM('<!doctype html><html><body>'
                + '<table id="datatable-send"><thead><tr><th>#</th></tr></thead><tbody></tbody></table>'
                + '</body></html>', { runScripts: 'outside-only', url: 'https://xchain.test/RDOGE/sends' });
            const win = dom.window;
            win.numeral = function(v){ return { format: function(){ return String(v); } }; };
            win.eval(JQUERY);
            win.jQuery.fn.ready = function(){ return this; };
            win.eval(SOURCE.clientSource());
            const captured = {};
            win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
            win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
            return { win, captured };
        }

        it('still tracks the offset cursor from the first and last row of a draw', function () {
            const { win, captured } = boot();
            win.loadDatatablesData('RDOGE', 'send', null, null);
            const o = {
                _iRecordsTotal: 40, _iDisplayLength: 10, _iDisplayStart: 10,
                json: { recordsTotal: 40, data: [[1, 100, 0, 'a', 1, 900], [2, 101, 0, 'b', 1, 917]] }
            };
            captured.config.fnDrawCallback.call({}, o);
            assert.equal(win.XC.datatables.send.offset_first, 900);
            assert.equal(win.XC.datatables.send.offset_last, 917,
                'the cursor is the LAST element of the row array; the feeds page on it');
            assert.equal(win.XC.datatables.send.last_start, 10);
            assert.equal(win.XC.datatables.send.total, 40);
        });

        it('zeroes the cursor on an empty draw rather than keeping a stale one', function () {
            const { win, captured } = boot();
            win.loadDatatablesData('RDOGE', 'send', null, null);
            captured.config.fnDrawCallback.call({}, {
                _iRecordsTotal: 0, _iDisplayLength: 10, _iDisplayStart: 0,
                json: { recordsTotal: 0, data: [] }
            });
            assert.equal(win.XC.datatables.send.offset_first, 0);
            assert.equal(win.XC.datatables.send.offset_last, 0);
        });

        it('reads the remembered page length out of localStorage', function () {
            const { win, captured } = boot();
            win.localStorage.setItem('records_per_page', '50');
            win.loadDatatablesData('RDOGE', 'send', null, null);
            assert.equal(captured.config.pageLength, 50);
        });

        it('asks for first/next/prev/last with the matching offset', function () {
            const { win, captured } = boot();
            win.loadDatatablesData('RDOGE', 'send', null, null);
            const track = win.XC.datatables.send;
            track.offset_first = 900; track.offset_last = 917; track.last_start = 10; track.total = 40;

            let req = { start: 0, length: 10 };
            captured.config.ajax.data(req);
            assert.equal(req.action, 'first');
            assert.equal(req.offset, null);

            req = { start: 20, length: 10 };
            captured.config.ajax.data(req);
            assert.equal(req.action, 'next');
            assert.equal(req.offset, 917);

            req = { start: 0, length: 10 };
            track.last_start = 20;
            captured.config.ajax.data(req);
            assert.equal(req.action, 'first');

            req = { start: 10, length: 10 };
            captured.config.ajax.data(req);
            assert.equal(req.action, 'prev');
            assert.equal(req.offset, 900);
        });

        it('runs the component hook after each draw, and only when one is given', function () {
            const { win, captured } = boot();
            const draws = [];
            win.loadDatatablesData('RDOGE', 'send', null, null, {
                columns: [{ label: '#' }],
                onDraw: function(tableId){ draws.push(tableId); }
            });
            captured.config.fnDrawCallback.call({}, {
                _iRecordsTotal: 0, _iDisplayLength: 10, _iDisplayStart: 0, json: { recordsTotal: 0, data: [] }
            });
            assert.deepEqual(draws, ['datatable-send']);

            const plain = boot();
            plain.win.loadDatatablesData('RDOGE', 'send', null, null);
            assert.doesNotThrow(() => plain.captured.config.fnDrawCallback.call({}, {
                _iRecordsTotal: 0, _iDisplayLength: 10, _iDisplayStart: 0, json: { recordsTotal: 0, data: [] }
            }), 'a hand-written call passes no opts and must not break');
        });

        it('builds the same feed URL it always did', function () {
            const { win, captured } = boot();
            win.loadDatatablesData('RDOGE', 'send', null, null);
            assert.equal(captured.config.ajax.url, '/RDOGE/explorer/sends');
        });
    });

    describe('the component declaration', function () {

        it('ships a template, a mount script, a stylesheet and a prop table', function () {
            for(const f of ['template.html', 'init.js', 'component.css', 'component.json'])
                assert.ok(fs.existsSync(path.join(COMPONENT_DIR, f)), 'data-table is missing ' + f);
        });

        it('declares in component.json exactly the props it registers', function () {
            const declared = Object.keys(JSON.parse(
                fs.readFileSync(path.join(COMPONENT_DIR, 'component.json'), 'utf8')).props).sort();
            const src = fs.readFileSync(path.join(COMPONENT_DIR, 'init.js'), 'utf8');
            const block = /props:\s*\{([\s\S]*?)\n        \}/.exec(src);
            assert.ok(block, 'no props block in init.js');
            const registered = [...block[1].matchAll(/^\s*([a-zA-Z]+):\s*\{/gm)].map((m) => m[1]).sort();
            assert.deepEqual(registered, declared,
                'component.json and the register() call disagree about the prop table; the '
                + 'browser validates against register(), so the JSON would be a lie');
        });
    });
});
