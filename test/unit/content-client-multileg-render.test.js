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
 * Three multi-leg defects found by driving RDOGE actions 1176, 1180 and 1183.
 *
 *   - A SEND carries a MEMO per leg. The legs table had no Memo column, so
 *     the memos appeared only inside the raw transaction data string.
 *   - A MINT carries a DESTINATION. The mints list had no Destination column
 *     and the feed did not return one, though the SQL selected it all along.
 *   - A multi-leg DESTROY came back in a sort order that CONTRADICTED the
 *     transaction: a burn written CAMPB then XCHAIN rendered XCHAIN first,
 *     because the leg query sorted by tick_id instead of leaving the legs in
 *     the order the indexer wrote them.
 *
 * The markup and the client are the SHIPPED files, so a renamed class or a
 * moved column fails here rather than silently rendering nothing again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
const CLIENT  = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION  = path.join(CONTENT, 'html', 'action.html');
const MINTS   = path.join(CONTENT, 'html', 'mints.html');

function bootClient(url, markup){
    const dom = new JSDOM('<!doctype html><html><body>' + (markup || '') + '</body></html>', {
        runScripts: 'outside-only',
        url: url
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(fs.readFileSync(CLIENT, 'utf8'));
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    const captured = {};
    win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    // The static action tables initialise through the same vendored plugin.
    return { win, captured };
}

// Run the shipped createdRow for a list page over one feed row.
function renderListRow(action, data, columns){
    const { win, captured } = bootClient('https://xchain.test/RDOGE/' + action + 's');
    const $ = win.jQuery;
    win.loadDatatablesData('RDOGE', action, null, null);
    expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    expect(captured.config.createdRow, 'the captured config carries no createdRow').to.be.a('function');
    const row = $('<tr>')[0];
    for(let i = 0; i < columns; i++)
        $(row).append($('<td>').text('PLACEHOLDER'));
    captured.config.createdRow.call(captured.config, row, data, 0);
    return $('td', row).map(function(){ return $(this).text(); }).get();
}

describe('multi-leg actions: legs the page could not show', function(){

    describe('SEND per-leg memo', function(){

        // Action 1180 on RDOGE: three legs, two ticks, a distinct memo on each.
        const LEGS_1180 = [
            { destination: 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li', tick: 'CAMPB',  amount: '2', memo: 'memo alpha',   status: 'valid' },
            { destination: 'mpTtWGjAy7TnxpsUw29weQr2gyfj3NkmTp', tick: 'XCHAIN', amount: '3', memo: 'memo bravo',   status: 'valid' },
            { destination: 'mrECHXeUhAJewbxSfkpv4GX4fgid74PUTJ', tick: 'CAMPB',  amount: '1', memo: 'memo charlie', status: 'valid' },
        ];

        function renderSend(legs){
            const { win } = bootClient('https://xchain.test/RDOGE/action/1180',
                                       fs.readFileSync(ACTION, 'utf8'));
            win.showSendDetails({ sends: legs });
            // Plain JS, not a nested jQuery .map(): that flattens a returned
            // array and would hand back one long list of characters.
            return win.jQuery('#datatable-send tbody tr').get().map(function(tr){
                return win.jQuery('td', tr).get().map(function(td){
                    return win.jQuery(td).text().trim();
                });
            });
        }

        it('renders each leg its own memo, in wire order', function(){
            const rows = renderSend(LEGS_1180);
            expect(rows.length).to.equal(3);
            expect(rows[0][4], 'leg 1 memo').to.equal('memo alpha');
            expect(rows[1][4], 'leg 2 memo').to.equal('memo bravo');
            expect(rows[2][4], 'leg 3 memo').to.equal('memo charlie');
        });

        it('keeps the leg fields beside the memo they belong to', function(){
            const rows = renderSend(LEGS_1180);
            expect(rows[1][1]).to.equal('mpTtWGjAy7TnxpsUw29weQr2gyfj3NkmTp');
            expect(rows[1][2]).to.equal('XCHAIN');
            expect(rows[1][3]).to.equal('3');
            expect(rows[1][5]).to.equal('valid');
        });

        it('renders an EMPTY memo cell for a leg that carries none, never the word null', function(){
            const rows = renderSend([
                { destination: 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li', tick: 'CAMPB', amount: '2', memo: null, status: 'valid' },
            ]);
            expect(rows[0][4]).to.equal('');
        });

        it('escapes a memo rather than letting it reach the DOM as markup', function(){
            const rows = renderSend([
                { destination: 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li', tick: 'CAMPB', amount: '2',
                  memo: '<img src=x onerror=1>', status: 'valid' },
            ]);
            expect(rows[0][4]).to.equal('<img src=x onerror=1>');
        });

        it('the shipped markup carries a Memo header for the cell to sit under', function(){
            const markup = fs.readFileSync(ACTION, 'utf8');
            const table  = markup.slice(markup.indexOf('id="datatable-send"'));
            const head   = table.slice(0, table.indexOf('</thead>'));
            expect(head).to.contain('>Memo<');
        });
    });

    describe('MINT destination', function(){

        // getMints feed shape after the fix: count, block, timestamp, source,
        // tick, amount, destination, status, action_index. Action 1176.
        it('renders the destination address and keeps the view link last', function(){
            const cells = renderListRow('mint',
                [1, 2899, 1787859393, 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li', 'CAMPB', '100',
                 'mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a', 1, 1176], 8);
            expect(cells[4]).to.equal('CAMPB');
            expect(cells[5]).to.equal('100');
            expect(cells[6], 'the Destination cell').to.equal('mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a');
            expect(cells[7], 'the view link moved one column right').to.equal('view');
        });

        it('leaves the cell EMPTY for a mint with no destination, never the word null', function(){
            // MINT|0|XCHAIN|1000 carries no DESTINATION, so the LEFT JOIN is null.
            const cells = renderListRow('mint',
                [1, 2898, 1787859381, 'mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a', 'XCHAIN', '1000',
                 null, 1, 1175], 8);
            expect(cells[6]).to.equal('');
            expect(cells[7]).to.equal('view');
        });

        it('the shipped markup carries a Destination header and a matching colspan', function(){
            const markup = fs.readFileSync(MINTS, 'utf8');
            const headRow = markup.slice(markup.indexOf('<thead>'), markup.indexOf('</thead>'));
            expect(headRow).to.contain('>Destination<');
            // [\s>] so the opening <thead> tag is not counted as a column
            const headers = (headRow.match(/<th[\s>]/g) || []).length;
            expect(headers, 'the mints table columns').to.equal(8);
            expect(markup, 'the loading row must span every column')
                .to.contain('colspan="' + headers + '"');
        });
    });

    describe('DESTROY leg order', function(){

        it('the leg query imposes no sort, so the legs keep the order they were written in', function(){
            const { DESTROY } = require('../../src/action-detail/tokens.js');
            const { query2 } = DESTROY.queries({ action_index: 1183 });
            expect(query2).to.contain('FROM');
            expect(query2, 'a sort key here silently contradicts the transaction')
                .to.not.match(/ORDER\s+BY/i);
        });

        it('renders the legs in the order the query returned them', function(){
            const { win } = bootClient('https://xchain.test/RDOGE/action/1183',
                                       fs.readFileSync(ACTION, 'utf8'));
            // tx_data DESTROY|2|CAMPB|2|burn alpha|XCHAIN|3|burn bravo
            win.showDestroyDetails({ destroys: [
                { tick: 'CAMPB',  amount: '2', memo: 'burn alpha', status: 'valid' },
                { tick: 'XCHAIN', amount: '3', memo: 'burn bravo', status: 'valid' },
            ]});
            const ticks = win.jQuery('#datatable-destroy tbody tr').map(function(){
                return win.jQuery('td', this).eq(1).text().trim();
            }).get();
            expect(ticks).to.deep.equal(['CAMPB', 'XCHAIN']);
        });
    });
});
