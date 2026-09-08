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
 * Rendering a contract's declared identity (spec contract-meta-manifest 2.6).
 *
 * meta.name and meta.description are author-supplied strings that the chain
 * stores verbatim and that reach an HTML sink on five surfaces. The consensus
 * grammar refuses bidi, zero-width and control code points, but only for
 * deploys at or after its flag day: every contract already on a chain can hold
 * any of them, so the neutralization has to happen HERE, at render, and the
 * assertions below are on the shipped functions rather than on a copy.
 *
 * The list row and the search row are driven through the shipped createdRow
 * (captured out of loadDatatablesData, the way the other content-client suites
 * do it), because a positional feed row is exactly where a column added in the
 * middle goes wrong, and an off-by-one there renders plausible, wrong values
 * rather than failing.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '../../src/content');
const CLIENT_SRC = require('../helpers/content-source.js').clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');

const RLO  = '\u202E';   // RIGHT-TO-LEFT OVERRIDE
const ZWSP = '\u200B';   // ZERO WIDTH SPACE
const SUB  = '\u2426';   // the visible stand-in the hardening leaves behind

function bootClient(){
    // The tables have to EXIST: loadDatatablesData binds its feed-url rewrite to the
    // table element, and a handler bound to an empty selection silently never fires,
    // which would make the search-box assertions below pass on nothing.
    const tables = '<table id="datatable-contract"></table><table id="datatable-send"></table>';
    const dom = new JSDOM('<!doctype html><html><body>' + tables + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/contracts'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    const captured = {};
    win.jQuery.fn.dataTable = function(config){ captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    win.XC = win.XC || {};
    win.XC.coin  = 'RDOGE';
    win.XC.chain = 'DOGE';
    return { win, captured };
}

// Drive the shipped createdRow for one feed row and read the cells back.
function renderRow(action, query, type, data, columns){
    const { win, captured } = bootClient();
    const $ = win.jQuery;
    if(query !== null) win.XC.query = query;
    win.loadDatatablesData('RDOGE', action, query, type);
    expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    const row = $('<tr>')[0];
    for(let i = 0; i < columns; i++)
        $(row).append($('<td>').text('PLACEHOLDER'));
    captured.config.createdRow.call(captured.config, row, data, 0);
    return {
        text: $('td', row).map(function(){ return $(this).text(); }).get(),
        html: $('td', row).map(function(){ return $(this).html(); }).get(),
        win:  win,
        config: captured.config
    };
}

describe('contract identity: render-side hardening and the label', function(){

    describe('hardenText', function(){

        it('replaces a bidi override with a VISIBLE placeholder, never silently', function(){
            const { win } = bootClient();
            // Silently dropping the override would let this read as a clean name,
            // which is the whole attack.
            const out = win.hardenText('evil' + RLO + 'txt');
            expect(out).to.include(SUB);
            expect(out).to.not.include(RLO);
        });

        it('drops zero-width characters and collapses what a control leaves behind', function(){
            const { win } = bootClient();
            expect(win.hardenText('Esc' + ZWSP + 'row')).to.equal('Escrow');
            expect(win.hardenText('Escrow\n\nv2')).to.equal('Escrow v2');
            expect(win.hardenText('  Escrow  ')).to.equal('Escrow');
        });

        it('answers empty for an absent value rather than the word null', function(){
            const { win } = bootClient();
            expect(win.hardenText(null)).to.equal('');
            expect(win.hardenText(undefined)).to.equal('');
        });

        it('truncates at the cap it is given', function(){
            const { win } = bootClient();
            const out = win.hardenText('x'.repeat(100), 64);
            expect(out).to.have.lengthOf(64);
            expect(out.endsWith('…')).to.equal(true);
        });
    });

    describe('formatContractName / formatContractIdentity', function(){

        it('renders name and version in the documented form', function(){
            const { win } = bootClient();
            expect(win.formatContractName('Escrow', '2.0.0')).to.include('Escrow');
            expect(win.formatContractName('Escrow', '2.0.0')).to.include('v2.0.0');
        });

        it('does not double the v when the author already wrote one', function(){
            const { win } = bootClient();
            expect(win.formatContractName('Escrow', 'v2.0.0')).to.not.include('vv2.0.0');
        });

        it('names a contract that declared nothing "Unnamed contract"', function(){
            const { win } = bootClient();
            expect(win.formatContractName(null, null)).to.include('Unnamed contract');
            expect(win.formatContractName('', '')).to.include('Unnamed contract');
        });

        it('escapes markup in a declared name before it reaches the sink', function(){
            const { win } = bootClient();
            const out = win.formatContractName('<img src=x onerror=alert(1)>', null);
            expect(out).to.not.include('<img');
            expect(out).to.include('&lt;img');
        });

        it('prints the name WITH the derived address, never instead of it', function(){
            const { win } = bootClient();
            const out = win.formatContractIdentity('RDOGE', 'DOGE', 2154, 'Escrow', '2.0.0');
            expect(out).to.include('Escrow');
            expect(out).to.include('C:DOGE:2154');
            expect(out).to.include('href="/RDOGE/contract/2154"');
        });

        it('prints the bare index rather than a malformed address when the chain is unknown', function(){
            const { win } = bootClient();
            const out = win.formatContractIdentity('RDOGE', null, 2154, 'Escrow', null);
            expect(out).to.not.include('C::');
            expect(out).to.include('href="/RDOGE/contract/2154"');
        });
    });

    describe('the contracts list row', function(){

        // getContracts shape: count, block, time, source, meta_name, code_hash,
        // api_version, cooldown_blocks, slash_destination, status, action_index.
        const listRow = (name) => [7, 500, 1700000000, 'srcAddr', name, 'abc123', 1, null, null, 1, 900];

        it('renders the declared name in the Name cell and keeps every later cell in place', function(){
            const out = renderRow('contract', null, null, listRow('Escrow'), 9);
            expect(out.text[3]).to.equal('srcAddr');
            expect(out.text[4]).to.equal('Escrow');
            expect(out.text[5]).to.equal('abc123');
            expect(out.text[6]).to.equal('1');
            expect(out.text[7]).to.equal('No');
            expect(out.html[8]).to.include('/RDOGE/contract/900');
        });

        it('says "Unnamed contract" for a pre-activation contract, not a blank cell', function(){
            const out = renderRow('contract', null, null, listRow(null), 9);
            expect(out.text[4]).to.equal('Unnamed contract');
        });

        it('hardens and escapes a hostile name in the list', function(){
            const out = renderRow('contract', null, null, listRow('<b>Bad' + RLO + '</b>'), 9);
            expect(out.html[4]).to.not.include('<b>');
            expect(out.html[4]).to.include(SUB);
        });
    });

    describe('the search Contract panel', function(){

        // getSearch contract shape: count, meta_name, meta_version, contract_address,
        // snippet, action_index.
        const hit = (over = {}) => [
            1,
            over.name === undefined ? 'Escrow' : over.name,
            over.version === undefined ? '2.0.0' : over.version,
            'C:DOGE:2154',
            over.snippet === undefined ? 'Two-party escrow with an arbiter' : over.snippet,
            2154
        ];

        it('shows the name, version, address and description of a hit', function(){
            const out = renderRow('contract', 'escrow', 'search', hit(), 6);
            expect(out.text[1]).to.equal('Escrow');
            expect(out.text[2]).to.equal('2.0.0');
            expect(out.text[3]).to.equal('C:DOGE:2154');
            expect(out.html[3]).to.include('href="/RDOGE/contract/2154"');
            expect(out.text[4]).to.equal('Two-party escrow with an arbiter');
            expect(out.html[5]).to.include('/RDOGE/contract/2154');
        });

        it('highlights the term inside the name and the description', function(){
            const out = renderRow('contract', 'escrow', 'search', hit(), 6);
            expect(out.html[1]).to.include('highlight-search-term');
            expect(out.html[4]).to.include('highlight-search-term');
        });

        it('renders a hit with no declared name or description without the word null', function(){
            const out = renderRow('contract', 'escrow', 'search', hit({ name: null, version: null, snippet: null }), 6);
            expect(out.text[1]).to.equal('Unnamed contract');
            expect(out.text[2]).to.equal('');
            expect(out.text[4]).to.equal('');
        });

        it('hardens and escapes a hostile name and description in the results', function(){
            const out = renderRow('contract', 'escrow', 'search',
                hit({ name: '<script>x</script>' + RLO, snippet: '<img src=x>' + ZWSP + 'ok' }), 6);
            expect(out.html[1]).to.not.include('<script');
            expect(out.html[1]).to.include(SUB);
            expect(out.html[4]).to.not.include('<img');
            expect(out.html[4]).to.include('ok');
        });
    });

    // The contract page's own render lives inline in its $.getJSON callback, which
    // no realm here can run without a server; what is pinned is the WIRING, so a
    // renamed cell or a raw field reaching the page fails here. The functions
    // themselves are driven above.
    describe('the contract page header', function(){

        const PAGE = require('../helpers/content-source.js').pageSource('contract.html');

        it('renders a Name row and a Description row', function(){
            expect(PAGE).to.include('class="contract-name"');
            expect(PAGE).to.include('class="contract-description text-break"');
        });

        it('builds the header through the shared label, with the derived address beside it', function(){
            expect(PAGE).to.include('formatContractName(o.meta_name, o.meta_version)');
            expect(PAGE).to.include("escapeHtml('C:' + XC.chain + ':' + o.action_index)");
        });

        it('hardens the description instead of writing the stored bytes straight out', function(){
            expect(PAGE).to.include('hardenText(o.meta_description, 512)');
        });
    });

    describe('the contracts list search box', function(){

        function boot(action){
            const { win, captured } = bootClient();
            win.loadDatatablesData('RDOGE', action, null, null);
            return { win, config: captured.config };
        }

        it('is enabled, with a filter slot, on the contracts list only', function(){
            const contracts = boot('contract');
            expect(contracts.config.searching, 'the contracts list has a searchable feed').to.equal(true);
            expect(contracts.config.dom).to.include('f>');

            const sends = boot('send');
            expect(sends.config.searching, 'a feed with no name index must not offer a box').to.equal(false);
            expect(sends.config.dom).to.not.include('f>');
        });

        // The feeds take their term as a PATH segment; DataTables sends it as a
        // request parameter, which they ignore. Without this the box would appear to
        // work and silently return the unfiltered list.
        it('rewrites the feed url to the name lane before the request goes out', function(){
            const { win } = bootClient();
            win.loadDatatablesData('RDOGE', 'contract', null, null);
            const settings = { ajax: { url: '/RDOGE/explorer/contracts' } };
            win.jQuery('#datatable-contract').trigger('preXhr.dt', [settings, { search: { value: 'escrow' } }]);
            expect(settings.ajax.url).to.equal('/RDOGE/explorer/contracts/escrow/name');
        });

        it('encodes the term rather than letting it shape the path', function(){
            const { win } = bootClient();
            win.loadDatatablesData('RDOGE', 'contract', null, null);
            const settings = { ajax: { url: '/RDOGE/explorer/contracts' } };
            win.jQuery('#datatable-contract').trigger('preXhr.dt', [settings, { search: { value: 'a/b?c#d' } }]);
            expect(settings.ajax.url).to.equal('/RDOGE/explorer/contracts/a%2Fb%3Fc%23d/name');
        });

        it('falls back to the unfiltered feed below the index minimum, not to an empty page', function(){
            const { win } = bootClient();
            win.loadDatatablesData('RDOGE', 'contract', null, null);
            for(const term of ['', '  ', 'es']){
                const settings = { ajax: { url: '/RDOGE/explorer/contracts/previous/name' } };
                win.jQuery('#datatable-contract').trigger('preXhr.dt', [settings, { search: { value: term } }]);
                expect(settings.ajax.url, 'term ' + JSON.stringify(term)).to.equal('/RDOGE/explorer/contracts');
            }
        });
    });
});
