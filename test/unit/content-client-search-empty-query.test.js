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
 * A bare /search or /{COIN}/search must make NO feed request.
 *
 * loadDatatablesData appends a QUERY segment only when there is one to append,
 * which for a search built /{COIN}/explorer/search/{TYPE}: four path segments
 * where the route '/{COIN}/explorer/search/{QUERY}/{TYPE}' declares five, and
 * no 3-segment list-all route exists for search either. Every one of the four
 * tabs therefore 404'd on arrival and painted the DataTables failure row before
 * the reader had typed anything.
 *
 * The empty state is a REQUEST the page should not have made, so the guard is
 * asserted as the absence of an ajax source rather than as the shape of the url
 * it would have built. The with-query path is asserted alongside it: the fix is
 * only correct if a real search still reaches the feed it always did.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '../../src/content');
const CLIENT_SRC = fs.readFileSync(path.join(CONTENT, 'js', 'xchain.js'), 'utf8');
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');

// The four result tabs search.html registers in XC.panels.
const SEARCH_PANELS = ['address', 'broadcast', 'token', 'transaction'];

// One jsdom realm carrying the shipped jQuery and the shipped client, matching
// content-client-search-null-render.test.js. dataTable() is stubbed to capture
// the config, which is the only place the ajax source is observable: the real
// DataTables would fire the request rather than hand it back.
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
    const captured = [];
    win.jQuery.fn.dataTable = function(config){ captured.push(config); return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

// Drive the page's own call shape: search.html calls
// loadDatatablesData(coin, <result type>, query, 'search') once per tab, and the
// function swaps the pair internally.
function loadSearchTabs(query){
    const { win, captured } = bootClient();
    win.XC.query = query;
    for(const panel of SEARCH_PANELS)
        win.loadDatatablesData('RDOGE', panel, query, 'search');
    expect(captured, 'loadDatatablesData did not reach .dataTable() for every tab')
        .to.have.lengthOf(SEARCH_PANELS.length);
    return { win, captured };
}

describe('search page with no query makes no feed request', () => {

    // null is what search.html sets XC.query to on the bare route; '' and '   '
    // are what the form yields when it is submitted empty, and unguarded, all
    // three build the same unroutable url.
    for(const [label, query] of [['a null query', null], ['an empty query', ''], ['a whitespace query', '   ']]){
        it('arms no ajax source on any of the four tabs with ' + label, () => {
            const { captured } = loadSearchTabs(query);
            for(let i = 0; i < captured.length; i++){
                const cfg = captured[i];
                expect(cfg.ajax, SEARCH_PANELS[i] + ' tab still carries an ajax feed').to.be.undefined;
                expect(cfg.data, SEARCH_PANELS[i] + ' tab has no local dataset to render')
                    .to.be.an('array').that.is.empty;
                // serverSide paging against a table with no feed asks DataTables
                // to page a source that does not exist.
                expect(cfg.serverSide, SEARCH_PANELS[i] + ' tab is still in server-side mode').to.equal(false);
            }
        });
    }

    it('names the empty state for a reader who has not searched yet', () => {
        const { captured } = loadSearchTabs(null);
        for(const cfg of captured)
            expect(cfg.language.zeroRecords).to.equal('Enter a search term above to see results');
    });

    it('renders a table per tab rather than skipping the tab entirely', () => {
        // The tabs must still be built: a reader switching tabs on a bare search
        // page has to see an empty table, not the "Loading ..." placeholder the
        // fragment ships frozen in place.
        const { captured } = loadSearchTabs(null);
        for(const cfg of captured){
            expect(cfg.createdRow, 'the empty table lost its row renderer').to.be.a('function');
            expect(cfg.fnDrawCallback, 'the empty table lost its draw callback').to.be.a('function');
        }
    });

    it('survives a draw with no ajax response to read', () => {
        // A client-side table hands fnDrawCallback a settings object with no
        // `json` at all, so an unguarded callback reading straight through it
        // would throw.
        const { captured } = loadSearchTabs(null);
        for(const cfg of captured){
            expect(() => cfg.fnDrawCallback.call(cfg, {
                _iRecordsTotal: 0,
                _iDisplayLength: 10,
                _iDisplayStart: 0
            })).to.not.throw();
        }
    });

    it('still fetches the real feed once a query exists', () => {
        const { captured } = loadSearchTabs('CAMPA');
        for(let i = 0; i < captured.length; i++){
            const cfg = captured[i];
            expect(cfg.ajax, SEARCH_PANELS[i] + ' tab lost its feed').to.be.an('object');
            expect(cfg.ajax.url).to.equal('/RDOGE/explorer/search/CAMPA/' + SEARCH_PANELS[i]);
            expect(cfg.serverSide).to.equal(true);
            expect(cfg.data, 'a fed table must not also carry a local dataset').to.not.be.an('array');
        }
    });

    it('never builds a search url with the query segment missing', () => {
        // The exact 404 shape, pinned directly: whatever the guard is spelled as,
        // /{COIN}/explorer/search/{TYPE} must never leave this function.
        for(const query of [null, '', '   ', 'CAMPA']){
            const { captured } = loadSearchTabs(query);
            for(const cfg of captured){
                if(!cfg.ajax) continue;
                expect(cfg.ajax.url, 'a search feed url is missing its query segment')
                    .to.not.match(/\/explorer\/search\/(address|broadcast|token|transaction)$/);
            }
        }
    });

    it('leaves non-search list feeds fetching with a null query', () => {
        // The guard is scoped to searches: /addresses and friends legitimately
        // list everything with no query at all, and must keep doing so.
        const { win, captured } = bootClient();
        win.loadDatatablesData('RDOGE', 'address', null, null);
        expect(captured).to.have.lengthOf(1);
        expect(captured[0].ajax).to.be.an('object');
        expect(captured[0].ajax.url).to.equal('/RDOGE/explorer/addresses');
        expect(captured[0].serverSide).to.equal(true);
    });

});
