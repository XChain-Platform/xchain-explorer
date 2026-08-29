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
const CLIENT   = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY   = path.join(CONTENT, 'js', 'jquery.min.js');
const EXPLORER = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');
const CLIENT_SRC = fs.readFileSync(CLIENT, 'utf8');

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

function pageSource(file){
    return fs.readFileSync(path.join(HTML_DIR, file), 'utf8');
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

describe('cancel/edit list pages', function () {

    // -----------------------------------------------------------------------
    // Wiring: all three registrations, for all six pages
    // -----------------------------------------------------------------------

    it('registers all six page routes against templates that exist on disk', function () {
        const routes  = htmlRoutes();
        const missing = [];
        for(const { route, file } of PAGES){
            if(routes.get(route) !== file)
                missing.push(`${route} is not mapped to ${file} in the html route table`);
            else if(!fs.existsSync(path.join(HTML_DIR, file)))
                missing.push(`${route} -> ${file} does not exist on disk`);
        }
        expect(missing, 'cancel/edit pages that would answer 404 or serve the\n'
            + '"Error loading html file!" sentinel:\n  ' + missing.join('\n  ')).to.deep.equal([]);
    });

    it('has each template call loadDatatablesData with the expected action name', function () {
        for(const { file, action } of PAGES){
            const calls = [...pageSource(file).matchAll(/loadDatatablesData\(\s*XC\.coin\s*,\s*'([a-z_\-]+)'/g)].map(m => m[1]);
            expect(calls, `${file} must load exactly one datatable`).to.deep.equal([action]);
        }
    });

    it('names its table datatable-<action>, which is what loadDatatablesData targets', function () {
        for(const { file, action } of PAGES)
            expect(pageSource(file), `${file} table id`).to.include(`id="datatable-${action}"`);
    });

    // The /api routes for these six already existed; loadDatatablesData does NOT
    // fetch /api, it fetches /{COIN}/explorer/<endpoint>.
    it('derives a REGISTERED /explorer endpoint for every one of the six actions', function () {
        const endpointFor = derivationRule();
        const registered  = registeredExplorerEndpoints();
        const broken      = [];
        for(const { file, action } of PAGES){
            const endpoint = endpointFor(action);
            if(!registered.has(endpoint))
                broken.push(`${file}: '${action}' -> /explorer/${endpoint} is not registered`);
        }
        expect(broken, 'actions resolving to an unregistered feed (the page renders\n'
            + 'as an empty table rather than as an error):\n  ' + broken.join('\n  ')).to.deep.equal([]);
    });

    // A registered feed with no row mapping serves raw objects: no error, blank cells.
    it('gives every one of the six feeds a getPagingDataResults row mapping', function () {
        const missing = PAGES.filter(p => pagingRowFields(p.method) === null).map(p => p.method);
        expect(missing, 'feed methods with no row mapping: ' + missing.join(', ')).to.deep.equal([]);
    });

    // The mapping's arity is the page's contract: the client indexes data[N] by
    // position, and the generic renderer consumes status at data[len-2] and the
    // paging cursor at data[len-1]. So a mapping is one element WIDER than the
    // page's column count (status has no column; action_index feeds the view one).
    it('matches every row mapping arity to its page <thead> count', function () {
        const wrong = [];
        for(const { file, method } of PAGES){
            const fields  = pagingRowFields(method);
            const columns = theadColumns(file);
            if(fields && fields.length !== columns + 1)
                wrong.push(`${method}: ${fields.length} fields vs ${file}'s ${columns} columns (+1 for status)`);
        }
        expect(wrong, 'row mappings that do not line up with their page:\n  ' + wrong.join('\n  ')).to.deep.equal([]);
    });

    // action_index LAST is the paging cursor fnDrawCallback reads; status
    // second-to-last is what the generic renderer colours the row from.
    it('keeps action_index last and status second-to-last in every mapping', function () {
        for(const { method } of PAGES){
            const fields = pagingRowFields(method);
            expect(fields, `${method} has no row mapping`).to.not.equal(null);
            expect(fields[fields.length - 1], `${method} paging cursor`).to.equal('info.action_index');
            expect(fields[fields.length - 2], `${method} status slot`).to.equal('status');
        }
    });

    it('links every page from the nav template', function () {
        const nav = fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8');
        for(const { route } of PAGES)
            expect(nav, `nav is missing a link to ${route}`).to.include(`href="${route}"`);
    });

    // -----------------------------------------------------------------------
    // Table shape
    // -----------------------------------------------------------------------

    it('keeps each <thead> column count equal to the loading-data colspan', function () {
        const wrong = [];
        for(const { file } of PAGES){
            const colspan = pageSource(file).match(/<td colspan="(\d+)" class="loading-data"/);
            expect(colspan, `${file} has no loading-data row`).to.not.equal(null);
            const columns = theadColumns(file);
            if(columns !== Number(colspan[1]))
                wrong.push(`${file}: ${columns} <th> vs colspan ${colspan[1]}`);
        }
        expect(wrong, 'header/loading-row width disagreements:\n  ' + wrong.join('\n  ')).to.deep.equal([]);
    });

    it('declares as many columns as the render branch fills', function () {
        for(const { file, action } of PAGES)
            expect(theadColumns(file), `${file} column count`).to.equal(NULL_ROWS[action].columns);
    });

    // -----------------------------------------------------------------------
    // Render: an edit that changed one thing carries nulls for the rest
    // -----------------------------------------------------------------------

    for(const { action } of PAGES){
        it(`renders no literal null/undefined/NaN cell for an all-null ${action} row`, function () {
            const { data, columns } = NULL_ROWS[action];
            const cells = renderRow(action, data, columns).text;
            const bad   = [];
            cells.forEach((cell, i) => {
                if(/\b(null|undefined|NaN)\b/.test(cell))
                    bad.push(`cell ${i} rendered "${cell}"`);
                if(cell === 'PLACEHOLDER')
                    bad.push(`cell ${i} was never written (kept its placeholder)`);
            });
            expect(bad, `${action} row leaked an absent value into the page:\n  ` + bad.join('\n  ')).to.deep.equal([]);
        });
    }

    it('shows a dash, not a blank, in every optional cell of an all-null row', function () {
        for(const { action } of PAGES){
            const { data, columns, optional } = NULL_ROWS[action];
            const cells = renderRow(action, data, columns).text;
            for(const slot of optional)
                expect(cells[slot], `${action} cell ${slot} should read '-' when its value is null`).to.equal('-');
        }
    });

    // A stringified absent value in the last path segment is a link to a record
    // that cannot exist (frontier row 107). Neither an all-null row nor a real
    // one may build one.
    it('never builds a /token/null or /action/null href on any of the six pages', function () {
        const bad = [];
        for(const { action } of PAGES){
            for(const source of [NULL_ROWS, REAL_ROWS]){
                const { data, columns } = source[action];
                renderRow(action, data, columns).html.forEach((cell, i) => {
                    const hrefs = [...String(cell).matchAll(/href="([^"]*)"/g)].map(m => m[1]);
                    for(const href of hrefs)
                        if(/\/(null|undefined)$/.test(href))
                            bad.push(`${action} cell ${i}: ${href}`);
                });
            }
        }
        expect(bad, 'dead links to records that cannot exist:\n  ' + bad.join('\n  ')).to.deep.equal([]);
    });

    // -----------------------------------------------------------------------
    // Render: the measured regtest payloads
    // -----------------------------------------------------------------------

    it('links a CANCEL back at the record it pulled, and shows its memo', function () {
        const expectations = [
            ['order_cancel',     1270, 'm3 cancelling order C', 1272],
            ['swap_cancel',      1281, 'm3 cancelling swap C',  1283],
            ['dispenser_cancel', 1316, 'm4-cancel-for-close',   1320]
        ];
        for(const [action, pointer, memo, actionIndex] of expectations){
            const { data, columns } = REAL_ROWS[action];
            const { html, text }    = renderRow(action, data, columns);
            expect(html[3], `${action} source cell`).to.include('/RDOGE/address/' + SRC_ADDR);
            expect(html[4], `${action} pointer cell`).to.include('/RDOGE/action/' + pointer);
            expect(text[5], `${action} memo cell`).to.equal(memo);
            expect(html[6], `${action} view button`).to.include('/RDOGE/action/' + actionIndex);
        }
    });

    it('links an EDIT back at the record it amended and renders what it changed', function () {
        for(const action of ['order_edit','swap_edit']){
            const { data, columns } = REAL_ROWS[action];
            const { html, text }    = renderRow(action, data, columns);
            expect(html[4], `${action} pointer cell`).to.include('/RDOGE/action/' + data[4]);
            // expiration is a Unix timestamp, rendered as a livestamp like every
            // other time column, NOT as a block height.
            expect(html[5], `${action} expiration cell`).to.include('data-livestamp="1799999999"');
            expect(text[6], `${action} untouched allow list`).to.equal('-');
            expect(text[7], `${action} untouched block list`).to.equal('-');
            expect(text[8], `${action} memo cell`).to.equal(data[8]);
        }
    });

    // The most common dispenser edit is a refill, which moves ONLY the escrow. If
    // an absent expiration were dropped rather than dashed, a refill would be
    // indistinguishable from an edit that cleared the expiration.
    it('renders a DISPENSER_EDIT refill: escrow present, expiration and lists dashed', function () {
        const { data, columns } = REAL_ROWS.dispenser_edit;
        const { html, text }    = renderRow('dispenser_edit', data, columns);
        expect(html[4], 'dispenser pointer').to.include('/RDOGE/action/1285');
        expect(text[5], 'the escrow this refill moved').to.equal('50');
        expect(text[6], 'an untouched expiration must read as a dash').to.equal('-');
        expect(text[7], 'an untouched allow list must read as a dash').to.equal('-');
        expect(text[8], 'an untouched block list must read as a dash').to.equal('-');
        expect(text[9], 'memo').to.equal('m3 dispenser refill');
        expect(html[10], 'view button').to.include('/RDOGE/action/1288');
    });

    // allow_list/block_list are ACTION INDEXES pointing at a LIST action, not
    // inline address lists, so a populated one must be a link to that action.
    it('links a populated allow/block list at the LIST action it names', function () {
        const { html } = renderRow('order_edit',
            [1, 3387, 1787937822, SRC_ADDR, 1271, 1799999999, 940, 941, 'restricted', 1, 1273], 10);
        expect(html[6], 'allow list').to.include('/RDOGE/action/940');
        expect(html[7], 'block list').to.include('/RDOGE/action/941');
    });

    // A memo is arbitrary on-chain bytes and reaches the cell through .text().
    it('does not let a memo inject markup into the page', function () {
        const { html, text } = renderRow('order_cancel',
            [1, 3386, 1787937816, SRC_ADDR, 1270, '<img src=x onerror=alert(1)>', 1, 1272], 7);
        expect(html[5], 'a memo must not reach the DOM as markup').to.not.include('<img');
        expect(text[5], 'the memo still reads verbatim').to.equal('<img src=x onerror=alert(1)>');
    });

});

// The dispenser/dispense legs are values, not accumulations onto the shared
// createdRow scratch variable. Behaviour must not change, so each leg is compared
// byte-for-byte against the prior expression, same helpers, same realm.

describe('dispenser/dispense legs are values, not shared scratch state', function () {

    const DISPENSER_TOKEN  = [1, 3400, 1787938500, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', 'CAMPE', '5',    0, 1290];
    const DISPENSER_NATIVE = [1, 3400, 1787938500, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', null,    '1000', 0, 1290];
    const DISPENSE_TOKEN   = [1, 3401, 1787938560, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', 'CAMPE', '5',    1, 1291];
    const DISPENSE_NATIVE  = [1, 3401, 1787938560, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', null,    '1000', 1, 1291];

    // Normalize a candidate string through the same .html() round trip the real
    // cell went through, so the comparison is of rendered DOM, not of source text.
    function throughDom(win, str){
        return win.jQuery('<td>').html(str).html();
    }

    it('renders a NATIVE-coin get leg byte-identically to the pre-refactor expression', function () {
        for(const [action, data] of [['dispenser', DISPENSER_NATIVE], ['dispense', DISPENSE_NATIVE]]){
            const { win, html } = renderRow(action, data, 7);
            const getCoin   = data[7];
            const getAmount = data[9];
            // The expression both branches carried before the refactor, verbatim.
            const legacy = ' <i class="fa ' + win.getNetworkIcon() + '"></i> '
                         + win.escapeHtml(getAmount) + ' ' + win.escapeHtml(getCoin);
            expect(html[5], `${action} native get leg changed`).to.equal(throughDom(win, legacy));
            // And it is really the native rendering: an icon, no token link.
            expect(html[5], `${action} native leg must carry the network icon`).to.include('<i class="fa ');
            expect(html[5], `${action} native leg must not link a token`).to.not.include('/token/');
        }
    });

    it('renders a TOKEN get leg byte-identically to the pre-refactor expression', function () {
        for(const [action, data] of [['dispenser', DISPENSER_TOKEN], ['dispense', DISPENSE_TOKEN]]){
            const { win, html } = renderRow(action, data, 7);
            const getCoin   = data[7];
            const getToken  = data[8];
            const getAmount = data[9];
            const legacy = win.formatLinkAmount('/' + getCoin + '/token/' + getToken, getToken, getToken, getAmount);
            expect(html[5], `${action} token get leg changed`).to.equal(throughDom(win, legacy));
            expect(html[5], `${action} token leg must link the token`).to.include('/RDOGE/token/CAMPE');
        }
    });

    // The give leg shares the cell above it and must be unaffected by the change.
    it('leaves the give leg unchanged for both a token and a native get leg', function () {
        for(const data of [DISPENSER_TOKEN, DISPENSER_NATIVE]){
            const { html } = renderRow('dispenser', data, 7);
            expect(html[4], 'give leg').to.include('/RDOGE/token/CAMPD');
        }
    });

    // The actual defect: `html` is the createdRow scratch variable, declared once
    // for the whole function and never reset between branches. Appending a leg
    // onto it made both cells inherit whatever an earlier matching branch had
    // left there. Nothing writes to it above these two today, which is exactly
    // why this was latent rather than visible - so the guard is on the SOURCE.
    it('never reads or writes the shared `html` scratch variable in either branch', function () {
        const start = CLIENT_SRC.indexOf("if(action=='dispenser'){");
        const end   = CLIENT_SRC.indexOf("if(action=='dividend'){");
        expect(start, "the dispenser render branch was not found").to.be.greaterThan(-1);
        expect(end,   "the dividend render branch (end marker) was not found").to.be.greaterThan(start);
        const body = CLIENT_SRC.slice(start, end);
        const hits = [...body.matchAll(/(^|[^.\w])html\s*\+?=[^=]/g)].map(m => m[0].trim());
        expect(hits, 'the dispenser/dispense branches still build a leg on the shared\n'
            + '`html` scratch variable; a branch added above them that touches it\n'
            + 'would silently prefix its content into both legs:\n  ' + hits.join('\n  ')).to.deep.equal([]);
    });

});
