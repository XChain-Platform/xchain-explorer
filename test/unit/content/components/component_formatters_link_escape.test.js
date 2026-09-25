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
 * A token issued with the tick "<TAMP0N>" showed no ticker at all on its
 * ISSUE page (/TDOGE/action/3039), though the API returned the tick intact.
 * formatLink appended its label raw, so the browser parsed "<TAMP0N>" as an
 * unknown element and the text vanished. Ticks may carry < > & " ' and
 * friends, so the same path also let a crafted tick inject markup.
 *
 * formatLink now escapes its label; formatLinkHtml is the explicit path for
 * a label that is already markup. These cases pin both halves against the
 * shipped client and the shipped action.html markup.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '..', '..', '../../src/content');
const CLIENT_SRC = require('../../../helpers/content-source.js').clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION     = path.join(CONTENT, 'html', 'action.html');

const TICK = '<TAMP0N>';

// One jsdom realm with the shipped jQuery, action.html and client, the way the
// action detail render suite boots it. The page's own script never runs, and
// dataTable() is stubbed to capture the config, because createdRow is a closure
// inside loadDatatablesData.
function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/3039'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin    = 'TDOGE';
    win.XC.network = 'testnet';
    win.captured = {};
    win.jQuery.fn.dataTable = function(config){ win.captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return win;
}

// Parse a rendered fragment the way .html() would.
function parse(win, html){
    const div = win.document.createElement('div');
    div.innerHTML = html;
    return div;
}

// Drive the shipped createdRow for one list action and return the row.
function renderRow(win, action, query, type, data, columns){
    win.loadDatatablesData('TDOGE', action, query, type);
    expect(win.captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    const row = win.jQuery('<tr>')[0];
    for(let i = 0; i < columns; i++)
        win.jQuery(row).append(win.jQuery('<td>'));
    win.captured.config.createdRow.call(win.captured.config, row, data, 0);
    return row;
}

describe('tick labels render as visible text, not markup @regression', function(){

    it('formatLink shows a tick shaped like a tag instead of swallowing it', function(){
        const win = bootPage();
        const out = parse(win, win.formatLink(win.tokenUrl('TDOGE', TICK), TICK, TICK));
        const a   = out.querySelector('a');
        expect(a.textContent).to.equal(TICK);
        expect(out.getElementsByTagName('tamp0n').length, 'tick parsed as an element').to.equal(0);
        expect(a.getAttribute('href')).to.equal('/TDOGE/token/%3CTAMP0N%3E');
    });

    it('formatLinkAmount shows the amount and the tick', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkAmount(win.tokenUrl('TDOGE', TICK), TICK, TICK, '1000'));
        expect(out.textContent).to.contain('1,000 ' + TICK);
        expect(out.getElementsByTagName('tamp0n').length).to.equal(0);
    });

    it('keeps an injection-shaped tick inert', function(){
        const win  = bootPage();
        const evil = '<img src=x onerror=alert(1)>';
        const out  = parse(win, win.formatLink(win.tokenUrl('TDOGE', evil), evil));
        expect(out.querySelectorAll('img').length).to.equal(0);
        expect(out.textContent).to.equal(evil);
    });

    it('escapes exactly once, so an entity-shaped tick reads as typed', function(){
        const win = bootPage();
        const out = parse(win, win.formatLink(win.tokenUrl('TDOGE', 'A&amp;B'), 'A&amp;B'));
        expect(out.textContent).to.equal('A&amp;B');
    });

    it('keeps the dead-link label escaped when the target is /token/null', function(){
        const win = bootPage();
        const out = parse(win, win.formatLink('/TDOGE/token/null', TICK));
        expect(out.querySelector('a')).to.equal(null);
        expect(out.textContent).to.equal(TICK);
    });

    it('shows the ticker on the ISSUE detail card', function(){
        const win = bootPage();
        win.showIssueDetails({ action_format: 0, tick: TICK });
        const cell = win.jQuery('#info-issue .issue-ticker');
        expect(cell.text().trim()).to.equal(TICK);
        expect(cell.find('tamp0n').length).to.equal(0);
        expect(cell.find('a').attr('href')).to.equal('/TDOGE/token/%3CTAMP0N%3E');
    });

    it('shows the ticker in the ISSUE one-line summary used by history rows', function(){
        const win = bootPage();
        const out = parse(win, win.getActionDetails('ISSUE', { tick: TICK }));
        expect(out.textContent).to.equal(TICK);
    });

});

describe('markup labels still render as markup through formatLinkHtml', function(){

    it('keeps a badge label as an element', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('/TDOGE/contract/7',
            '<span class="badge text-bg-danger">Binding</span>'));
        expect(out.querySelector('a > span.badge').textContent).to.equal('Binding');
    });

    it('keeps the search highlight on a token hit while escaping the tick', function(){
        const win = bootPage();
        win.XC.query = 'TAMP';
        // getSearch token shape: count, tick, description, action_index.
        const row  = renderRow(win, 'token', 'TAMP', 'search', [1, TICK, 'desc', 42], 4);
        const cell = win.jQuery('td', row).eq(1);
        expect(cell.find('a span.highlight-search-term').text()).to.equal('TAMP');
        expect(cell.find('a').text()).to.equal(TICK);
        expect(cell.find('tamp0n').length).to.equal(0);
    });

    it('renders a market pair with its icons and both ticks as text', function(){
        const win = bootPage();
        const row  = renderRow(win, 'market', null, null, [1, TICK, 'TDOGE', '1', '1', '1', '1', '0'], 8);
        const cell = win.jQuery('td', row).eq(1);
        expect(cell.find('a img').length).to.equal(2);
        expect(cell.find('a').text()).to.equal(TICK + ' / TDOGE');
    });

});
