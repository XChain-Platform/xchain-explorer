/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The six user-written cancel/edit list pages (order/swap/dispenser cancels
 * and edits), and the shared-scratch-variable fix in the dispenser/dispense
 * render branches.
 *
 * A list page needs THREE registrations, not one, and every missing piece
 * fails silently in a different way:
 *
 *  - no 'html' route: /{COIN}/order_cancels answers 404 on every coin;
 *  - no '/explorer' feed route: the page's ajax 404s and DataTables draws an
 *    empty table, which reads as "no records" rather than as a defect (the
 *    /explorer feed is what a page pages over - the /api feed these six
 *    already had is NOT the one loadDatatablesData asks for);
 *  - no getPagingDataResults row mapping: the feed serves raw objects and
 *    every cell renders blank, again with no error anywhere.
 *
 * On top of that, an EDIT row exists only for what it changed, so its
 * amended fields are nullable by design: a DISPENSER_EDIT that refilled the
 * escrow carries a null expiration and null lists. Those must reach the page
 * as a dash, never as the literal word "null" and never as an /action/null
 * href.
 *
 * The render assertions drive the SHIPPED createdRow closure against the
 * SHIPPED jQuery, so they fail on real behaviour rather than on a copy of it.
 * The harness is the one content-client-expire-list-pages.test.js uses.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const ROOT     = path.resolve(__dirname, '../..');
const CONTENT  = path.join(ROOT, 'src', 'content');
const HTML_DIR = path.join(CONTENT, 'html');
// The shipped client source, from the shared helper: the cell-rendering
// helpers (isNull, escapeHtml, formatAmount, formatLink and friends) moved
// out of xchain.js into formatters.js in the component milestone, and this
// suite needs whichever of the two a given function landed in.
const CLIENT_SRC = require('../helpers/content-source.js').clientSource();
const JQUERY   = path.join(CONTENT, 'js', 'jquery.min.js');
const EXPLORER = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');

// The six pages this row adds: page route -> template file, the action name the
// template hands loadDatatablesData, and the feed method behind it.
const PAGES = [
    { route: '/{COIN}/order_cancels',     file: 'order_cancels.html',     action: 'order_cancel',     method: 'getOrderCancels'     },
    { route: '/{COIN}/order_edits',       file: 'order_edits.html',       action: 'order_edit',       method: 'getOrderEdits'       },
    { route: '/{COIN}/swap_cancels',      file: 'swap_cancels.html',      action: 'swap_cancel',      method: 'getSwapCancels'      },
    { route: '/{COIN}/swap_edits',        file: 'swap_edits.html',        action: 'swap_edit',        method: 'getSwapEdits'        },
    { route: '/{COIN}/dispenser_cancels', file: 'dispenser_cancels.html', action: 'dispenser_cancel', method: 'getDispenserCancels' },
    { route: '/{COIN}/dispenser_edits',   file: 'dispenser_edits.html',   action: 'dispenser_edit',   method: 'getDispenserEdits'   }
];

// ---------------------------------------------------------------------------
// Source readers. Everything is read out of the shipped source rather than
// restated, so an assertion cannot drift away from what actually ships.
// ---------------------------------------------------------------------------

// The 'html' route table, scoped to that one table so an 'api'/'explorer' entry
// ending in .html cannot be mistaken for a page route.
function htmlRoutes(){
    const table = EXPLORER.match(/'html'\s*:\s*\{([\s\S]*?)\n {12}\},/);
    if(!table) throw new Error('could not locate the html route table in src/XChainExplorer.js');
    const out = new Map();
    for(const m of table[1].matchAll(/'([^']*)'\s*:\s*'([^']*\.html)'/g))
        out.set(m[1], m[2]);
    return out;
}

function registeredExplorerEndpoints(){
    const out = new Set();
    for(const m of EXPLORER.matchAll(/'\/\{COIN\}\/explorer\/([a-z_]+)/g))
        out.add(m[1]);
    return out;
}

// The row array getPagingDataResults builds for one feed method, as a list of
// its element expressions. null when the method has no mapping at all.
function pagingRowFields(method){
    const m = EXPLORER.match(new RegExp("method=='" + method + "'\\)\\s*\\n\\s*info = \\[([^\\]]*)\\];"));
    if(!m) return null;
    return m[1].split(',').map(s => s.trim()).filter(s => s !== '');
}

// The endpoint-derivation rule as loadDatatablesData actually implements it: the
// irregular branches are read out of the function, not copied.
function derivationRule(){
    const fn = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function loadDatatablesData('));
    const es = fn.match(/\}\s*else if\(\[([^\]]+)\]\.includes\(action\)\)\{\s*(?:\/\/[^\n]*\n\s*)*endpoint = action \+ 'es';/);
    if(!es) throw new Error("the '-es' branch of loadDatatablesData was not found");
    const esNames = es[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    return function(action){
        if(['history','search'].includes(action))   return action;
        if(esNames.includes(action))                return action + 'es';
        if(action === 'validator_capability')       return 'validator_capabilities';
        if(action === 'consensus_state')            return 'consensus_state';
        if(action === 'market-history')             return 'market';
        return action + 's';
    };
}

// 76 list pages have no fragment of their own any more: they are composed from
// content/layouts/list-pages.json (spec M2.3). The helper asks the composer
// first and the filesystem second, so these assertions read what the route
// actually SERVES rather than what happens to be on disk.
const SOURCE = require('../helpers/content-source.js');

function pageSource(file){
    return SOURCE.pageSource(file);
}

function theadColumns(file){
    const head = pageSource(file).match(/<thead>([\s\S]*?)<\/thead>/);
    expect(head, `${file} has no <thead>`).to.not.equal(null);
    return [...head[1].matchAll(/<th[\s>]/g)].length;
}

// ---------------------------------------------------------------------------
// Render harness: one jsdom realm carrying the shipped jQuery and the shipped
// client, with dataTable() stubbed so the createdRow closure can be captured.
// ---------------------------------------------------------------------------

function bootClient(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/order_cancels'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    const captured = {};
    win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

// Drive the shipped createdRow for `action` over one feed row; return the text
// and html of every rendered <td>, plus the realm (for legacy-expression
// comparisons that must use the SAME helper implementations).
function renderRow(action, data, columns){
    const { win, captured } = bootClient();
    const $ = win.jQuery;
    win.loadDatatablesData('RDOGE', action, null, null);
    expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    expect(captured.config.createdRow, 'the captured datatable config carries no createdRow').to.be.a('function');
    const row = $('<tr>')[0];
    for(let i = 0; i < columns; i++)
        $(row).append($('<td>').text('PLACEHOLDER'));
    captured.config.createdRow.call(captured.config, row, data, 0);
    return {
        win,
        text: $('td', row).map(function(){ return $(this).text(); }).get(),
        html: $('td', row).map(function(){ return $(this).html(); }).get()
    };
}

// Rows shaped exactly as getPagingDataResults builds them: count/block/timestamp
// lead, status and action_index trail, every optional column in between null.
const NULL_ROWS = {
    order_cancel:     { data: [1, 3386, 1787937816, null, null, null, 1, 1272], columns: 7,  optional: [3,4,5] },
    swap_cancel:      { data: [1, 3395, 1787938100, null, null, null, 1, 1283], columns: 7,  optional: [3,4,5] },
    dispenser_cancel: { data: [1, 3535, 1787964325, null, null, null, 1, 1320], columns: 7,  optional: [3,4,5] },
    order_edit:       { data: [1, 3387, 1787937822, null, null, null, null, null, null, 1, 1273], columns: 10, optional: [3,4,5,6,7,8] },
    swap_edit:        { data: [1, 3396, 1787938150, null, null, null, null, null, null, 1, 1284], columns: 10, optional: [3,4,5,6,7,8] },
    dispenser_edit:   { data: [1, 3399, 1787938437, null, null, null, null, null, null, null, 1, 1288], columns: 11, optional: [3,4,5,6,7,8,9] }
};

// The real regtest payloads these pages were built against (RDOGE, measured).
const SRC_ADDR = 'mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a';
const REAL_ROWS = {
    order_cancel:     { data: [1, 3386, 1787937816, SRC_ADDR, 1270, 'm3 cancelling order C',       1, 1272], columns: 7 },
    swap_cancel:      { data: [1, 3395, 1787938100, SRC_ADDR, 1281, 'm3 cancelling swap C',        1, 1283], columns: 7 },
    dispenser_cancel: { data: [1, 3535, 1787964325, SRC_ADDR, 1316, 'm4-cancel-for-close',         1, 1320], columns: 7 },
    order_edit:       { data: [1, 3387, 1787937822, SRC_ADDR, 1271, 1799999999, null, null, 'm3 edited order D expiration', 1, 1273], columns: 10 },
    swap_edit:        { data: [1, 3396, 1787938150, SRC_ADDR, 1282, 1799999999, null, null, 'm3 edited swap D expiration',  1, 1284], columns: 10 },
    // The refill: it moved ONLY the escrow, so its expiration and both lists are
    // legitimately null on a row that is otherwise fully populated.
    dispenser_edit:   { data: [1, 3399, 1787938437, SRC_ADDR, 1285, '50', null, null, null, 'm3 dispenser refill', 1, 1288], columns: 11 }
};

module.exports = {
    CLIENT_SRC, PAGES, htmlRoutes, registeredExplorerEndpoints, pagingRowFields,
    derivationRule, SOURCE, pageSource, theadColumns, renderRow, NULL_ROWS,
    REAL_ROWS, SRC_ADDR
};
require('./content_client_cancel_edit_list_pages.test/support/list_pages.js');
require('./content_client_cancel_edit_list_pages.test/support/dispenser_legs.js');
