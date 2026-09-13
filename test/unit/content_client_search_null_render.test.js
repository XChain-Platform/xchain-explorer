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
 * The search page renders its result cells through highlightSearchTerm(), not
 * through the .text() path the nullToBlank guard covers, so it kept the null
 * defect after that fix landed: String(null) is the four-character word "null",
 * and highlightSearchTerm coerced before it checked anything.
 *
 * Found by driving /RDOGE/search?query=CAMPA on the regtest venue, where the
 * Broadcast tab showed "null" in Message for a BROADCAST v3 (which carries no
 * message by wire design) and "null" in Memo for a v0 (which carries no memo).
 *
 * Every search result type routes through the same helper, so the guard is
 * asserted at the helper AND through the shipped createdRow, which is the only
 * place the coercion actually reaches a user.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
// The shipped client source, from the shared helper: the cell-rendering
// helpers (isNull, escapeHtml, formatAmount, formatLink and friends) moved
// out of xchain.js into formatters.js in the component milestone, and this
// suite needs whichever of the two a given function landed in.
const CLIENT_SRC  = require('../helpers/content-source.js').clientSource();
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');

// One jsdom realm carrying the shipped jQuery and the shipped client, matching
// content-client-null-cell-render.test.js: dataTable() is stubbed to capture the
// config, because createdRow is a closure inside loadDatatablesData.
function bootClient(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/search'
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

// Drive the shipped createdRow for one search result type. The search page calls
// loadDatatablesData(coin, <result type>, query, 'search'), which swaps the pair
// internally, so this mirrors the real call rather than the post-swap values.
function renderSearchRow(resultType, query, data, columns){
    const { win, captured } = bootClient();
    const $ = win.jQuery;
    win.XC.query = query;
    win.loadDatatablesData('RDOGE', resultType, query, 'search');
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

describe('search result cells fed a null column', function () {

    // The behavior the guard exists for. If this stops holding the guard is not
    // the thing to change, the coercion is.
    it('confirms String(null) is the word "null"', function () {
        expect(String(null)).to.equal('null');
    });

    it('blanks a null at the helper itself, for every result type at once', function () {
        const { win } = bootClient();
        expect(win.highlightSearchTerm('CAMPA', null)).to.equal('');
        expect(win.highlightSearchTerm('CAMPA', undefined)).to.equal('');
    });

    it('renders an EMPTY Message cell for a BROADCAST v3 result', function () {
        // getSearch broadcast shape: count, message, memo, action_index.
        const out = renderSearchRow('broadcast', 'CAMPA', [1, null, 'campaign feed update', 42], 4);
        expect(out.text[1], 'the Message cell rendered the literal string "null"').to.equal('');
        expect(out.text[2], 'the memo that IS present must survive').to.equal('campaign feed update');
    });

    it('renders an EMPTY Memo cell for a BROADCAST that carries none', function () {
        const out = renderSearchRow('broadcast', 'CAMPA', [1, 'campaign message', null, 42], 4);
        expect(out.text[2]).to.equal('');
        expect(out.text[1]).to.equal('campaign message');
    });

    it('renders an EMPTY Description cell for a token that has none', function () {
        // getSearch token shape: count, tick, description, action_index.
        const out = renderSearchRow('token', 'CAMPA', [1, 'CAMPA', null, 42], 4);
        expect(out.text[2]).to.equal('');
        expect(out.text[1]).to.equal('CAMPA');
    });

    // The guard must not cost the page its actual job.
    it('still highlights a matching term in a value that IS present', function () {
        const out = renderSearchRow('broadcast', 'campaign', [1, 'campaign message', 'a memo', 42], 4);
        expect(out.html[1]).to.contain('highlight-search-term');
        expect(out.text[1]).to.equal('campaign message');
    });

    // A zero or an empty string is a real value, not an absent one.
    it('leaves a real empty string and a zero alone', function () {
        const { win } = bootClient();
        expect(win.highlightSearchTerm('x', '')).to.equal('');
        expect(win.highlightSearchTerm('x', 0)).to.equal('0');
    });
});
