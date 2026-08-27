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
 * /{COIN}/oracle/{addr} renders the PRICE v1 track record.
 *
 * Drives oracle.html's SHIPPED inline script in JSDOM. What it protects:
 *  - the page reads the /api/oracle record as the endpoint actually returns
 *    it (flat, `runtime` appended); reading only a {data:...} envelope left
 *    every count rendering as zero whatever the API said;
 *  - a PRICE v1 publisher's record (the new `price` half) is rendered, with
 *    null (mirror unavailable) kept distinct from a genuine zero record;
 *  - the page loads the address-filtered oracle_price datatable through the
 *    shipped loadDatatablesData machinery;
 *  - TICK is user-created and reaches the DOM only as text, never as markup.
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC_DIR     = path.resolve(__dirname, '../../src/content');
const PAGE_HTML   = fs.readFileSync(path.join(SRC_DIR, 'html/oracle.html'), 'utf8');
const JQUERY_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.join(SRC_DIR, 'js/numeral.js'), 'utf8');

const ORACLE = 'ms2Qea1kzmENE798jGfXREMM4wGHQJkxyt';

// The page fragment's inline loader (the LAST <script> block), run as shipped.
function inlineScript() {
    const open = PAGE_HTML.lastIndexOf('<script type="text/javascript">');
    if (open < 0) throw new Error('inline script block not found in oracle.html');
    const bodyStart = PAGE_HTML.indexOf('>', open) + 1;
    const end = PAGE_HTML.indexOf('</script>', bodyStart);
    if (end < 0) throw new Error('unterminated inline script in oracle.html');
    return PAGE_HTML.slice(bodyStart, end);
}

function pageMarkup() {
    return PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
}

// Boots the page with a canned /api/oracle response and returns the window
// once jQuery's (async) ready handlers have run.
async function bootPage(apiResponse) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + pageMarkup() + '</body>',
        { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(JQUERY_SRC);
    w.eval(NUMERAL_SRC);
    w.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(t){ return '<span class="livestamp" data-t="' + t + '"></span>'; }
        function updatePageInfo(){}
    `);
    w.XC = { coin: 'rdoge', name: 'Dogecoin', network: 'regtest', query: ORACLE, pageInfo: {}, datatables: {} };
    w.__datatableCalls = [];
    w.loadDatatablesData = function (coin, action, query, type) {
        w.__datatableCalls.push({ coin, action, query, type });
    };
    w.__getJSONCalls = [];
    w.$.getJSON = function (url, cb) {
        w.__getJSONCalls.push(url);
        if (apiResponse !== undefined) cb(apiResponse);
    };
    w.eval(inlineScript());
    // jQuery fires ready handlers asynchronously even on a complete document.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    return w;
}

// The record as /api/oracle/{addr} actually serves it: flat, runtime appended.
const FLAT_RECORD = {
    address: ORACLE, total_feeds: 4, active_feeds: 1,
    counts: { open: 1, closed: 0, resolved: 2, resolved_void: 0, cancelled: 1, expired: 0 },
    fees_earned: [],
    price: {
        total_publishes: 3,
        pairs: [
            { coin: 'DOGE', tick: 'CAMPA', fiat: 'USD', publishes: 2, first_publish: 1787848846, last_publish: 1787848894 },
            { coin: 'DOGE', tick: 'OTHER', fiat: 'EUR', publishes: 1, first_publish: 1787000000, last_publish: 1787000000 },
        ]
    },
    reputation_caveat: 'caveat',
    runtime: '3ms'
};

describe('oracle.html PRICE v1 track record render @regression', function () {

    it('renders the price publishes, pairs and last-publish from the flat API record', async function () {
        const w = await bootPage(FLAT_RECORD);
        const $ = w.$;
        expect($('#oracle-price-publishes').text().trim()).to.equal('3');
        const pairsText = $('#oracle-price-pairs').text();
        expect(pairsText).to.include('DOGE/CAMPA/USD (2 publishes)');
        expect(pairsText).to.include('DOGE/OTHER/EUR (1 publish)');
        // Latest publish across pairs, not the first listed
        expect($('#oracle-price-last .livestamp').attr('data-t')).to.equal('1787848894');
    });

    it('reads the flat record for the betting half too (the {data:...} envelope was never what the API returns)', async function () {
        const w = await bootPage(FLAT_RECORD);
        const $ = w.$;
        expect($('#oracle-total').text().trim()).to.equal('4');
        expect($('#oracle-active').text().trim()).to.equal('1');
        expect($('#oracle-resolved').text().trim()).to.equal('2');
        expect($('#oracle-cancelled').text().trim()).to.equal('1');
    });

    it('price:null (no co-located mirror) renders as unavailable, not as a clean zero history', async function () {
        const w = await bootPage(Object.assign({}, FLAT_RECORD, { price: null }));
        const $ = w.$;
        expect($('#oracle-price-publishes').text()).to.include('Unavailable');
        expect($('#oracle-price-pairs').text().trim()).to.equal('None');
    });

    it('a genuine zero record renders as 0 / None', async function () {
        const w = await bootPage(Object.assign({}, FLAT_RECORD, { price: { total_publishes: 0, pairs: [] } }));
        const $ = w.$;
        expect($('#oracle-price-publishes').text().trim()).to.equal('0');
        expect($('#oracle-price-pairs').text().trim()).to.equal('None');
        expect($('#oracle-price-last').text().trim()).to.equal('-');
    });

    it('loads the address-filtered oracle_price datatable alongside the bet_feed one', async function () {
        const w = await bootPage(FLAT_RECORD);
        expect(w.__datatableCalls).to.deep.include(
            { coin: 'rdoge', action: 'oracle_price', query: ORACLE, type: 'address' });
        expect(w.__datatableCalls).to.deep.include(
            { coin: 'rdoge', action: 'bet_feed', query: ORACLE, type: 'source' });
        expect(w.__getJSONCalls).to.deep.equal(['/rdoge/api/oracle/' + ORACLE]);
    });

    it('a hostile TICK reaches the DOM as text, never as markup', async function () {
        const hostile = Object.assign({}, FLAT_RECORD, { price: {
            total_publishes: 1,
            pairs: [{ coin: 'DOGE', tick: '<img src=x onerror=alert(1)>', fiat: 'USD',
                      publishes: 1, first_publish: 1, last_publish: 1 }]
        } });
        const w = await bootPage(hostile);
        const $ = w.$;
        expect($('#oracle-price-pairs img').length).to.equal(0, 'tick markup executed in the DOM');
        expect($('#oracle-price-pairs').text()).to.include('<img src=x onerror=alert(1)>');
    });
});
