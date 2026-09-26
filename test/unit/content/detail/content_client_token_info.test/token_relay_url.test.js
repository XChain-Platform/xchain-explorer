/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const SOURCE = require('../../../../helpers/content-source.js');
// The copy the /relay endpoint loads: the same file, required through Node.
const { tokenInfo_metadataUrl } = require(SOURCE.JS_DIR + '/xchain/token_info.js');

const PAGE_HTML = fs.readFileSync(SOURCE.HTML_DIR + '/token.html', 'utf8');
const TOKEN_INFO_SRC = fs.readFileSync(SOURCE.JS_DIR + '/xchain/token_info.js', 'utf8');
const JQUERY_SRC = fs.readFileSync(SOURCE.JS_DIR + '/jquery.min.js', 'utf8');

const FAIRYWINK_URL = 'https://cryptowave.neocities.org/smokingfairywink.json';
const STARE_URL     = 'https://ooakosimo.github.io/velvetduck-xchain-lab/xmeta/stare.json';

// Boot the token page with every metadata fetch recorded; the direct fetch fails the
// way the page's connect-src policy makes it fail for an off-origin host.
function boot(){
    const markup = PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/token/FAIRYWINK'
    });
    const win = dom.window;
    win.eval(JQUERY_SRC);
    win.eval(SOURCE.formatterSource());
    win.eval(`
        var XC = { coin: 'TDOGE', coin_price: '1' };
        var fetched = [];
        function bcformat(value, decimals){ return Number(value).toFixed(decimals); }
        function bcmul(a, b, decimals){ return (Number(a) * Number(b)).toFixed(decimals); }
        function showLockStatus(value){ return value ? 'Locked' : 'Unlocked'; }
        function getValidUrl(url){ return url; }
        function showTokenContent(){}
        jQuery.getJSON = function(url){
            fetched.push(url);
            return { fail: function(fn){ fn(); return this; } };
        };
    `);
    win.eval(TOKEN_INFO_SRC);
    return win;
}

function tokenFixture(tick, description){
    return {
        controllers: [], open_polls: [], linked_files: [], projects: [], registry: null,
        info: { tick: tick, coin: 'TDOGE', owner: 'owner', description: description },
        supply: { current: '1', max: '1' }, mints: { max: '1' },
        market: { price: null, floor: null }, lists: { allow: null, block: null },
        callback: { tick: null, block: null, amount: null, price: null },
        locks: {}
    };
}

describe('client: token metadata URL rule shared with the relay', function () {
    // action: and short ord: forms derive through page-only helpers and never name a
    // non-gateway host, so the relay does not need them and they are left out here.
    const descriptions = [
        FAIRYWINK_URL,
        STARE_URL,
        'http://example.org/meta.json',
        'https://example.org/meta.json;see the site',
        'example.org/meta.json',
        'https://example.org/page',
        'ipfs://QmMetadataHash',
        'ar:abc123',
        'https://arweave.net/abc123/x.json',
        'ord:' + 'ab'.repeat(32),
        'just a sentence',
        null
    ];
    for (const desc of descriptions) {
        it(`derives the same URL on the page and in Node for ${JSON.stringify(desc)}`, function () {
            const win = boot();
            const pageUrl = win.tokenInfo_getJsonUrl(win.tokenInfo_prepareDescription(desc));
            expect(tokenInfo_metadataUrl(desc)).to.equal(pageUrl);
            expect(win.tokenInfo_metadataUrl(desc)).to.equal(pageUrl);
        });
    }

    it('derives an ordinary JSON host to the URL itself', function () {
        expect(tokenInfo_metadataUrl(FAIRYWINK_URL)).to.equal(FAIRYWINK_URL);
        expect(tokenInfo_metadataUrl('http://example.org/meta.json;x')).to.equal('https://example.org/meta.json');
    });
});

describe('client: token metadata relay request', function () {
    it('asks the relay with the page coin and the token tick after the direct fetch fails', function () {
        const win = boot();
        win.XC.tokenInfo = tokenFixture('FAIRYWINK', FAIRYWINK_URL);
        win.showTokenInfo();

        expect(win.fetched).to.have.length(2);
        expect(win.fetched[0]).to.equal(FAIRYWINK_URL);
        const relay = new URL(win.fetched[1], 'https://xchain.test');
        expect(relay.pathname).to.equal('/relay');
        expect(relay.searchParams.get('url')).to.equal(FAIRYWINK_URL);
        expect(relay.searchParams.get('coin')).to.equal('TDOGE');
        expect(relay.searchParams.get('tick')).to.equal('FAIRYWINK');
    });

    it('keeps a query string inside the metadata URL instead of splitting it into relay parameters', function () {
        const win = boot();
        const inscription = 'https://inscription-decoder.vercel.app/api/image?type=json&tx=' + 'ab'.repeat(32);
        const relay = new URL(win.tokenInfo_relayUrl(inscription, 'TDOGE', 'A&B'), 'https://xchain.test');

        expect(relay.searchParams.get('url')).to.equal(inscription);
        expect(relay.searchParams.get('tick')).to.equal('A&B');
        expect(relay.searchParams.has('tx')).to.be.false;
    });
});
