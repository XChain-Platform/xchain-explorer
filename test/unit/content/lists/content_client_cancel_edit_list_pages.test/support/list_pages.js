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

const { expect } = require('chai');
const {
    PAGES, htmlRoutes, registeredExplorerEndpoints, pagingRowFields,
    derivationRule, SOURCE, pageSource, theadColumns, renderRow,
    NULL_ROWS, REAL_ROWS, SRC_ADDR
} = require('../../content_client_cancel_edit_list_pages.test.js');

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
            else if(!SOURCE.pageExists(file))
                missing.push(`${route} -> ${file} is served by neither the composer nor a fragment`);
        }
        expect(missing, 'cancel/edit pages that would answer 404 or serve the\n'
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

});

describe('cancel/edit list pages', function () {

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
        // The shell on disk carries a {NAV} slot now; the nav markup itself is a
        // component (spec M2.4). shellSource() is what a browser receives.
        const nav = SOURCE.shellSource();
        for(const { route } of PAGES)
            expect(nav, `nav is missing a link to ${route}`).to.include(`href="${route}"`);
    });

});

describe('cancel/edit list pages', function () {

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

});

describe('cancel/edit list pages', function () {

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

});

describe('cancel/edit list pages', function () {

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

});

describe('cancel/edit list pages', function () {

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
