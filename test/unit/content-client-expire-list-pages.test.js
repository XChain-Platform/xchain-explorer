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
 * The five Tier-4 terminal-state list pages (order/swap/dispenser/coinpay
 * expirations and dispenser closes). Every one of them can fail SILENTLY:
 *
 *  - a missing 'html' route answers the shell with a 404 and no page;
 *  - a page whose action name pluralizes to an unregistered /explorer feed
 *    renders as an empty table, which reads as "no records" rather than as a
 *    defect (the class content-client-datatable-endpoints.test.js pins);
 *  - a <thead> whose column count disagrees with the loading-data colspan
 *    misaligns the loading row against the header;
 *  - a nullable feed column reaching .text() prints the literal word "null",
 *    and a null tick reaching a link builds an href ending in /token/null,
 *    which is a link to a token that cannot exist (frontier row 107).
 *
 * The render assertions drive the SHIPPED createdRow closure against the
 * SHIPPED jQuery, so they fail on the real behaviour rather than on a copy of
 * it. The harness is the one content-client-null-cell-render.test.js uses.
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
const CLIENT_SRC   = require('../helpers/content-source.js').clientSource();
const JQUERY   = path.join(CONTENT, 'js', 'jquery.min.js');
const EXPLORER = fs.readFileSync(path.join(ROOT, 'src', 'XChainExplorer.js'), 'utf8');

// The five pages this row adds: route -> template file, and the action name the
// template is expected to hand loadDatatablesData.
const PAGES = [
    { route: '/{COIN}/order_expires',      file: 'order_expires.html',      action: 'order_expire'      },
    { route: '/{COIN}/swap_expires',       file: 'swap_expires.html',       action: 'swap_expire'       },
    { route: '/{COIN}/dispenser_expires',  file: 'dispenser_expires.html',  action: 'dispenser_expire'  },
    { route: '/{COIN}/dispenser_closes',   file: 'dispenser_closes.html',   action: 'dispenser_close'   },
    { route: '/{COIN}/coinpay_expires',    file: 'coinpay_expires.html',    action: 'coinpay_expire'    }
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

// Every method getPagingDataResults builds an explicit row array for. A feed
// route with no mapping here serves raw objects, which DataTables renders as
// blank cells with no error anywhere.
function mappedPagingMethods(){
    const out = new Set();
    for(const m of EXPLORER.matchAll(/method=='(get[A-Za-z]+)'\)?\s*\n?\s*info = \[/g))
        out.add(m[1]);
    for(const m of EXPLORER.matchAll(/\[([^\]]*)\]\.includes\(method\)\)\s*\n\s*info = \[/g))
        for(const name of m[1].split(','))
            out.add(name.trim().replace(/^'|'$/g, ''));
    return out;
}

// The endpoint-derivation rule as loadDatatablesData actually implements it: the
// irregular branches are read out of the function, not copied.
function derivationRule(){
    const body = CLIENT_SRC;
    const fn   = body.slice(body.indexOf('function loadDatatablesData('));
    const es   = fn.match(/\}\s*else if\(\[([^\]]+)\]\.includes\(action\)\)\{\s*(?:\/\/[^\n]*\n\s*)*endpoint = action \+ 'es';/);
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

// ---------------------------------------------------------------------------
// Render harness: one jsdom realm carrying the shipped jQuery and the shipped
// client, with dataTable() stubbed so the createdRow closure can be captured.
// ---------------------------------------------------------------------------

function bootClient(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/order_expires'
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

// Drive the shipped createdRow for `action` over one feed row; return both the
// text and the html of every rendered <td>.
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
        text: $('td', row).map(function(){ return $(this).text(); }).get(),
        html: $('td', row).map(function(){ return $(this).html(); }).get()
    };
}

// An all-null row for each action, shaped exactly as getPagingDataResults builds
// it: count / block / timestamp lead, status and action_index trail, every
// optional column in between set to null.
const NULL_ROWS = {
    order_expire:     { data: [1, 3539, 1787964454, null, null, 1, 1321], columns: 6 },
    swap_expire:      { data: [1, 3539, 1787964454, null, null, 1, 1321], columns: 6 },
    dispenser_expire: { data: [1, 3539, 1787964454, null, null, 1, 1321], columns: 6 },
    dispenser_close:  { data: [1, 3505, 1787964043, null, null, null, null, null, null, null, null, null, 1, 1312], columns: 9 },
    coinpay_expire:   { data: [1, 3539, 1787964454, null, 1, 1321], columns: 5 }
};

describe('Tier-4 expire/close list pages', function () {

    // -----------------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------------

    it('registers all five page routes against templates that exist on disk', function () {
        const routes  = htmlRoutes();
        const missing = [];
        for(const { route, file } of PAGES){
            if(routes.get(route) !== file)
                missing.push(`${route} is not mapped to ${file} in the html route table`);
            else if(!SOURCE.pageExists(file))
                missing.push(`${route} -> ${file} is served by neither the composer nor a fragment`);
        }
        expect(missing, 'expire/close pages that would answer 404 or serve the\n'
            + '"Error loading html file!" sentinel:\n  ' + missing.join('\n  ')).to.deep.equal([]);
    });

    it('has each template call loadDatatablesData with the expected action name', function () {
        for(const { file, action } of PAGES){
            // A composed page names its action in the mount manifest rather than
            // in an inline call; the helper reads whichever form the page uses.
            const calls = SOURCE.pageActions(file);
            expect(calls, `${file} must load exactly one datatable`).to.deep.equal([action]);
        }
    });

    it('names its table datatable-<action>, which is what loadDatatablesData targets', function () {
        for(const { file, action } of PAGES)
            expect(pageSource(file), `${file} table id`).to.include(`id="datatable-${action}"`);
    });

    it('derives a REGISTERED /explorer endpoint for every one of the five actions', function () {
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
    it('gives every one of the five feeds a getPagingDataResults row mapping', function () {
        const mapped  = mappedPagingMethods();
        const missing = ['getOrderExpires','getSwapExpires','getDispenserExpires','getDispenserCloses','getCoinpayExpires']
            .filter(m => !mapped.has(m));
        expect(missing, 'feed methods with no row mapping: ' + missing.join(', ')).to.deep.equal([]);
    });

    it('links every page from the nav template', function () {
        // The shell on disk carries a {NAV} slot now; the nav markup itself is a
        // component (spec M2.4). shellSource() is what a browser receives.
        const nav = SOURCE.shellSource();
        for(const { route } of PAGES)
            expect(nav, `nav is missing a link to ${route}`).to.include(`href="${route}"`);
    });

    // -----------------------------------------------------------------------
    // Table shape
    // -----------------------------------------------------------------------

    it('keeps each <thead> column count equal to the loading-data colspan', function () {
        const wrong = [];
        for(const { file } of PAGES){
            const src     = pageSource(file);
            const head    = src.match(/<thead>([\s\S]*?)<\/thead>/);
            const colspan = src.match(/<td colspan="(\d+)" class="loading-data"/);
            expect(head,    `${file} has no <thead>`).to.not.equal(null);
            expect(colspan, `${file} has no loading-data row`).to.not.equal(null);
            const columns = [...head[1].matchAll(/<th[\s>]/g)].length;
            if(columns !== Number(colspan[1]))
                wrong.push(`${file}: ${columns} <th> vs colspan ${colspan[1]}`);
        }
        expect(wrong, 'header/loading-row width disagreements:\n  ' + wrong.join('\n  ')).to.deep.equal([]);
    });

    // The render branch indexes data[N] by position, so the column count the page
    // declares must match the number of cells the branch actually addresses.
    it('declares as many columns as the render branch fills', function () {
        for(const { file, action } of PAGES){
            const colspan = Number(pageSource(file).match(/<td colspan="(\d+)" class="loading-data"/)[1]);
            expect(colspan, `${file} column count`).to.equal(NULL_ROWS[action].columns);
        }
    });

    // -----------------------------------------------------------------------
    // Render: no null/undefined/NaN cell anywhere
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
        // Only the cells the branch OWNS (slot 3 onward, minus the trailing view
        // button) are optional; count/block/time are always present.
        const expectations = [
            ['order_expire',     [3, 4]],
            ['swap_expire',      [3, 4]],
            ['dispenser_expire', [3, 4]],
            ['dispenser_close',  [3, 4, 5, 6, 7]],
            ['coinpay_expire',   [3]]
        ];
        for(const [action, slots] of expectations){
            const { data, columns } = NULL_ROWS[action];
            const cells = renderRow(action, data, columns).text;
            for(const slot of slots)
                expect(cells[slot], `${action} cell ${slot} should read '-' when its value is null`).to.equal('-');
        }
    });

    // -----------------------------------------------------------------------
    // Render: real rows, measured against the live regtest feed payloads
    // -----------------------------------------------------------------------

    it('links an ORDER_EXPIRE back at the order it retired', function () {
        const { html } = renderRow('order_expire', [1, 3539, 1787964454, 'mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a', 1306, 1, 1321], 6);
        expect(html[3], 'source cell').to.include('/RDOGE/address/mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a');
        expect(html[4], 'order pointer cell').to.include('/RDOGE/action/1306');
        expect(html[5], 'view button').to.include('/RDOGE/action/1321');
    });

    it('links a COINPAY_EXPIRE back at the obligation it closed out', function () {
        const { html } = renderRow('coinpay_expire', [1, 3539, 1787964454, 998, 1, 1321], 5);
        // Slot 3 is the obligation, NOT an address: the generic renderer writes an
        // address link there for every row, so the branch must overwrite it.
        expect(html[3], 'obligation cell must not be rendered as an address').to.not.include('/address/');
        expect(html[3]).to.include('/RDOGE/action/998');
        expect(html[4]).to.include('/RDOGE/action/1321');
    });

    it('renders both legs of a token/token DISPENSER_CLOSE as token links', function () {
        const { html } = renderRow('dispenser_close',
            [1, 3505, 1787964043, 'mgUKnyQe27YhMdKtbwfGAfQqxT6X5uoNa5', 1309,
             'DOGE', 'CAMPD', '10', 'DOGE', 'CAMPE', '5', 'empty', 1, 1312], 9);
        expect(html[4]).to.include('/RDOGE/action/1309');
        expect(html[5], 'give leg').to.include('/DOGE/token/CAMPD');
        expect(html[6], 'get leg').to.include('/DOGE/token/CAMPE');
    });

    // Frontier row 107: an absent tick means the leg is the NATIVE coin, and a link
    // to /token/null points at a token that cannot exist.
    it('never builds a /token/null href for a native-coin DISPENSER_CLOSE leg', function () {
        const { html, text } = renderRow('dispenser_close',
            [1, 3505, 1787964043, 'mgUKnyQe27YhMdKtbwfGAfQqxT6X5uoNa5', 1309,
             'DOGE', null, '10', 'DOGE', 'CAMPE', '5', 'empty', 1, 1312], 9);
        expect(html[5], 'a null tick must not become a token link').to.not.match(/href="[^"]*\/token\/(null|undefined)"/);
        expect(html[5], 'a native-coin leg carries no token link at all').to.not.include('/token/');
        expect(text[5], 'the native leg still names its amount and coin').to.equal('10 DOGE');
    });

    // The two close reasons are identical in every other column, so the badge is
    // the ONLY thing telling a drained dispenser from a withdrawn one.
    it('renders the two DISPENSER_CLOSE reasons distinguishably, and a dash for none', function () {
        const base = (reason) => [1, 3505, 1787964043, 'mgUKnyQe27YhMdKtbwfGAfQqxT6X5uoNa5', 1309,
                                  'DOGE', 'CAMPD', '10', 'DOGE', 'CAMPE', '5', reason, 1, 1312];
        const drained   = renderRow('dispenser_close', base('empty'), 9);
        const cancelled = renderRow('dispenser_close', base('cancelled'), 9);
        const absent    = renderRow('dispenser_close', base(null), 9);

        expect(drained.text[7],   'a drained close must say so').to.equal('empty');
        expect(cancelled.text[7], 'a cancelled close must say so').to.equal('cancelled');
        expect(absent.text[7],    'an old row with no reason must read as a dash').to.equal('-');

        expect(drained.html[7],   'the reason must be a badge').to.include('badge');
        expect(cancelled.html[7], 'the reason must be a badge').to.include('badge');
        // Same words in the same badge shape would still be readable; different
        // words in the SAME COLOUR would not be distinguishable at a glance, which
        // is what the acceptance test asks for.
        const colourOf = (html) => (String(html).match(/text-bg-([a-z]+)/) || [])[1];
        expect(colourOf(drained.html[7]), 'drained badge has no colour token').to.be.a('string');
        expect(colourOf(cancelled.html[7]), 'cancelled badge has no colour token').to.be.a('string');
        expect(colourOf(drained.html[7]))
            .to.not.equal(colourOf(cancelled.html[7]), 'both close reasons render in the same badge colour');
    });

});
