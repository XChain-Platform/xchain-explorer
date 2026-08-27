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
 * The /explorer feeds deliver a real JS null for every column the indexer is
 * allowed to leave NULL, and jQuery 1.10.2 (the build this app ships) does not
 * treat that as "no text": .text(null) STRINGIFIES it, writing the literal four
 * characters "null" into the cell. /RDOGE/broadcasts shipped that way - a
 * BROADCAST v3 carries no MESSAGE, so its Message column read "null" on the live
 * page rather than reading empty.
 *
 * This drives the shipped createdRow handler for real, against the shipped
 * jQuery, with a null in the nullable column, and asserts the cell comes out
 * empty. Nothing else in the suite executes that handler, so nothing else can
 * catch the class coming back.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
const CLIENT  = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');

// One jsdom realm carrying the shipped jQuery and the shipped client. dataTable()
// is stubbed to capture the config object rather than render anything, which is
// the only way to reach createdRow: it is a closure inside loadDatatablesData.
function bootClient(){
    // A real origin is required: the client aliases localStorage at load time, and
    // jsdom refuses localStorage on the default opaque origin.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/broadcasts'
    });
    const win = dom.window;
    // numeral() is a vendored third-party lib the page loads separately; only the
    // .format() shape matters here.
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    // The client ends in a $(document).ready(...) that boots the whole page.
    // Neutralize it before the client is evaluated; this test is about one handler.
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(fs.readFileSync(CLIENT, 'utf8'));
    const captured = {};
    win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

// Run the shipped createdRow for `action` over one feed row and return the
// rendered <td> text, cell by cell.
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
    return $('td', row).map(function(){ return $(this).text(); }).get();
}

describe('list-page cells fed a null feed column', function () {

    // The behavior the whole fix exists for. If this ever stops holding, the
    // helper is not the thing to change: the jQuery build is.
    it('confirms the shipped jQuery stringifies .text(null)', function () {
        const { win } = bootClient();
        const $ = win.jQuery;
        expect($('<td>').text(null).text()).to.equal('null');
    });

    it('renders an EMPTY Message cell for a BROADCAST that carries none', function () {
        // getBroadcasts feed shape: count, block_index, timestamp, source, message,
        // value, fee, status, action_index. broadcasts.message is a nullable column
        // and BROADCAST v3 never writes one.
        const cells = renderRow('broadcast', [1, 500, 1756200000, 'mwXyz', null, '0', '0', 1, 42], 8);
        expect(cells[4], 'the Message cell rendered the literal string "null"').to.equal('');
    });

    it('still renders a BROADCAST message that IS present', function () {
        const cells = renderRow('broadcast', [1, 500, 1756200000, 'mwXyz', 'hello world', '0', '0', 1, 42], 8);
        expect(cells[4]).to.equal('hello world');
    });

    // The same hazard on every other createdRow cell handed a raw nullable column.
    it('renders an EMPTY Memo cell for a LINK that carries none', function () {
        // getLinks: count, block, timestamp, source, coin1, coin1_index, coin2,
        // coin2_index, memo, status, action_index. memo arrives through a LEFT JOIN
        // on index_memos, so it is null whenever the LINK carried no memo.
        const cells = renderRow('link', [1, 500, 1756200000, 'mwXyz', 'RDOGE', 7, 'RBTC', 9, null, 1, 42], 8);
        expect(cells[6]).to.equal('');
    });

    it('renders an EMPTY Method cell for an EXECUTE that names none', function () {
        // getExecutions: count, block, timestamp, contract_index, caller, method_name,
        // gas_used, status, action_index. contract_executions.method_name is nullable.
        const cells = renderRow('execution', [1, 500, 1756200000, 12, 'mwXyz', null, 21000, 1, 42], 8);
        expect(cells[5]).to.equal('');
    });

    it('renders an EMPTY Status cell for an unresolved ATTEST', function () {
        // getAttestations: count, block, timestamp, source, version, provider_id,
        // request_id, request_status, response_status, status, action_index. Both
        // status ENUMs are nullable with no default.
        const cells = renderRow('attestation', [1, 500, 1756200000, 'mwXyz', 0, 'http_get', 'ab'.repeat(32), null, null, 1, 42], 9);
        expect(cells[7]).to.equal('');
    });

    // .text(undefined) is read as the GETTER, so a short feed row silently keeps
    // whatever markup the cell already held. The helper closes that too.
    it('blanks a cell whose feed column is absent entirely', function () {
        const cells = renderRow('broadcast', [1, 500, 1756200000, 'mwXyz', undefined, '0', '0', 1, 42], 8);
        expect(cells[4], 'the Message cell kept its pre-existing content').to.equal('');
    });

});
