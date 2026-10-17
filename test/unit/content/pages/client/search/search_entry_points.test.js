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
 * Both ways into a search route through searchDestination: the search page
 * (reached by its own form, the header form, or a link) and the header search
 * box. Each is driven through its SHIPPED code, the search page's inline script
 * and the header form wired by initPage, so the two cannot drift apart.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { bootClient, SOURCES } = require('./support/boot');

const HASH      = 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d';
const BTC_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const STATUS    = {
    supported:  { BTC: true, TBTC: true },
    available:  { BTC: true, TBTC: true },
    last_block: { BTC: 900000, TBTC: 156400 }
};
const HEADER_FORM = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', '..',
    'src', 'content', 'components', 'search-box', 'template.html'), 'utf8');

// Run search.html's inline script against its own markup. The status read is
// answered from STATUS and every tab load is recorded, so a page that redirects
// is seen to fetch nothing and a token search is seen to fetch the token feed.
function openSearchPage(url){
    const page   = SOURCES.pageSource('search.html');
    const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(page);
    if(!script) throw new Error('search.html no longer carries its inline script');
    const { win, navigations } = bootClient(url, page.replace(script[0], ''));
    const loads = [];
    win.getExplorerStatusInfo = function(cb){ win.XC.status = STATUS; if(typeof cb == 'function') cb(STATUS); };
    win.loadDatatablesData = function(coin, action, query, type){ loads.push([coin, action, query, type]); };
    win.XC.debug = false;
    win.jQuery.fn.ready = function(fn){ fn(); return this; };
    win.eval(script[1]);
    return { win, navigations, loads };
}

describe('search page routes a query that names one record', () => {

    const CASES = [
        ['an address',              'https://xchain.test/BTC/search?query=' + BTC_P2PKH, '/BTC/address/' + BTC_P2PKH],
        ['a transaction hash',      'https://xchain.test/TBTC/search?query=' + HASH,     '/TBTC/transaction/' + HASH],
        ['a block height',          'https://xchain.test/TBTC/search?query=156304',      '/TBTC/block/156304'],
        ['a number past the tip',   'https://xchain.test/TBTC/search?query=9000000',     '/TBTC/action/9000000'],
        ['the ?q= alias',           'https://xchain.test/TBTC/search?q=156304',          '/TBTC/block/156304'],
        ['the header form post',    'https://xchain.test/search?coin=TBTC&query=' + HASH, '/TBTC/transaction/' + HASH]
    ];

    for(const [label, url, dest] of CASES){
        it('replaces itself with the record page for ' + label, () => {
            const { navigations, loads } = openSearchPage(url);
            expect(navigations).to.deep.equal([{ dest: dest, replace: true }]);
            expect(loads, 'a redirecting search page still fetched a search feed').to.deep.equal([]);
        });
    }

    it('keeps a token search on the page and loads the token feed as before', () => {
        const { win, navigations, loads } = openSearchPage('https://xchain.test/TBTC/search?query=CAMPA');
        expect(navigations).to.deep.equal([]);
        expect(loads).to.deep.equal([['TBTC', 'token', 'CAMPA', 'search']]);
        expect(win.jQuery('#search-query').val()).to.equal('CAMPA');
    });

    it('runs the token search for a ?q= query too', () => {
        const { loads } = openSearchPage('https://xchain.test/TBTC/search?q=CAMPA');
        expect(loads).to.deep.equal([['TBTC', 'token', 'CAMPA', 'search']]);
    });

    it('publishes the same canonical for ?q= as for ?query=', () => {
        const a = openSearchPage('https://xchain.test/TBTC/search?q=CAMPA').win.XC.pageInfo.canonical;
        const b = openSearchPage('https://xchain.test/TBTC/search?query=CAMPA').win.XC.pageInfo.canonical;
        expect(a).to.equal('/search?coin=TBTC&query=CAMPA');
        expect(b).to.equal(a);
    });

    it('leaves a bare search page without a query alone', () => {
        const { navigations, loads, win } = openSearchPage('https://xchain.test/TBTC/search');
        expect(navigations).to.deep.equal([]);
        expect(loads).to.deep.equal([['TBTC', 'token', null, 'search']]);
        expect(win.XC.pageInfo.canonical).to.equal('/search?coin=TBTC');
    });

});

// Boot a page carrying the shipped header form and run initPage, which is what
// wires it. Native form submission is recorded instead of performed.
function openHeader(url){
    const { win, navigations } = bootClient(url, HEADER_FORM);
    win.getExplorerStatusInfo = function(cb){ win.XC.status = STATUS; if(typeof cb == 'function') cb(STATUS); };
    win.getCoinNetworkInfo = function(){};
    const posts = [];
    win.HTMLFormElement.prototype.submit = function(){ posts.push(this.id); };
    win.initPage();
    win.XC.status = STATUS;
    const search = function(query){
        win.jQuery('#mainmenu-search [name="query"]').val(query);
        win.jQuery('#button-search').click();
    };
    return { win, navigations, posts, search };
}

describe('header search box agrees with the search page', () => {

    it('opens the record page directly for a query that names one record', () => {
        for(const [query, dest] of [[BTC_P2PKH, '/BTC/address/' + BTC_P2PKH], [HASH, '/BTC/transaction/' + HASH], ['800000', '/BTC/block/800000']]){
            const { navigations, posts, search } = openHeader('https://xchain.test/BTC/blocks');
            search(query);
            expect(navigations, query).to.deep.equal([{ dest: dest, replace: false }]);
            expect(posts, query + ' also posted to the search page').to.deep.equal([]);
        }
    });

    it('posts a token query to the search page for the coin being viewed', () => {
        const { win, navigations, posts, search } = openHeader('https://xchain.test/TBTC/blocks');
        search('CAMPA');
        expect(navigations).to.deep.equal([]);
        expect(posts).to.deep.equal(['mainmenu-search']);
        expect(win.jQuery('#coin-search').val()).to.equal('TBTC');
    });

});

describe('header search box agrees with the search page (continued)', () => {

    it('lets the search page decide a number past the cached tip', () => {
        // The search page re-reads the tip before calling a number an action
        // index; the header box has only the cached one, so it defers.
        const { navigations, posts, search } = openHeader('https://xchain.test/TBTC/blocks');
        search('9000000');
        expect(navigations).to.deep.equal([]);
        expect(posts).to.deep.equal(['mainmenu-search']);
    });

    it('defers a number to the search page while no status is cached', () => {
        // With no tip at all the header box cannot tell a block from an action
        // index; the search page fetches one, so the header box hands it over.
        const { win, navigations, posts, search } = openHeader('https://xchain.test/TBTC/blocks');
        win.XC.status = null;
        search('9000000');
        expect(navigations).to.deep.equal([]);
        expect(posts).to.deep.equal(['mainmenu-search']);
    });

    // Where a header search ends up: its own navigation, or, when it posted the
    // form, wherever the search page sends that same query.
    function headerLanding(query, status){
        const header = openHeader('https://xchain.test/BTC/blocks');
        header.win.XC.status = status;
        header.search(query);
        if(header.navigations.length) return header.navigations[0].dest;
        expect(header.posts, query + ' neither navigated nor posted').to.deep.equal(['mainmenu-search']);
        const page = openSearchPage('https://xchain.test/search?coin=BTC&query=' + encodeURIComponent(query));
        return page.navigations.length ? page.navigations[0].dest : null;
    }

    for(const [label, status] of [['a cached status', STATUS], ['no cached status', null]]){
        it('lands every query where the search page does, with ' + label, () => {
            for(const query of [BTC_P2PKH, HASH, '156304', '9000000', 'CAMPA']){
                const page = openSearchPage('https://xchain.test/search?coin=BTC&query=' + encodeURIComponent(query));
                const viaPage = page.navigations.length ? page.navigations[0].dest : null;
                expect(headerLanding(query, status), query).to.equal(viaPage);
            }
        });
    }

});
