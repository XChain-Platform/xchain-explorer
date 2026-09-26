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

const PAGE_HTML = fs.readFileSync(SOURCE.HTML_DIR + '/token.html', 'utf8');
const TOKEN_INFO_SRC = fs.readFileSync(SOURCE.JS_DIR + '/xchain/token_info.js', 'utf8');
const JQUERY_SRC = fs.readFileSync(SOURCE.JS_DIR + '/jquery.min.js', 'utf8');

function tokenFixture(overrides){
    const token = {
        controllers: [],
        open_polls: [],
        linked_files: [],
        projects: [],
        registry: null,
        info: { tick: 'BEER', coin: 'TLTC', owner: 'owner', description: null },
        supply: { current: '3', max: '10' },
        mints: { max: '2' },
        market: { price: null, floor: null },
        lists: { allow: null, block: null },
        callback: { tick: null, block: null, amount: null, price: null },
        locks: {
            max_supply: false, max_mint: false, mint: false, mint_supply: false,
            description: false, sleep: false, callback: false
        }
    };
    return Object.assign(token, overrides || {});
}

function boot(){
    const markup = PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TLTC/token/BEER'
    });
    const win = dom.window;
    win.eval(JQUERY_SRC);
    win.eval(SOURCE.formatterSource());
    win.eval(`
        var XC = { coin: 'TLTC', coin_price: '4' };
        function bcformat(value, decimals){ return Number(value).toFixed(decimals); }
        function bcmul(a, b, decimals){ return (Number(a) * Number(b)).toFixed(decimals); }
        function showLockStatus(value){ return value ? 'Locked' : 'Unlocked'; }
    `);
    win.eval(TOKEN_INFO_SRC);
    return win;
}

function text(win, selector){
    return win.jQuery(selector).text().trim();
}

describe('client: token summary nullable fields', function () {
    it('renders an absent description and market values as unavailable', function () {
        const win = boot();
        const token = tokenFixture();
        win.tokenInfo_renderSummary(token, token.info.description);

        expect(text(win, '#token-description')).to.equal('No description');
        [
            '#market-price-coin', '#market-price-fiat',
            '#market-floor-coin', '#market-floor-fiat',
            '#market-marketcap-coin', '#market-marketcap-fiat'
        ].forEach(function(selector){
            expect(text(win, selector), selector).to.equal('-');
        });
        expect(text(win, '#token-info, #token-market-info')).not.to.match(/null|undefined|NaN/i);
    });

    it('prints the native coin symbol once for each market amount', function () {
        const win = boot();
        const token = tokenFixture({ market: { price: '2', floor: '1' } });
        win.tokenInfo_renderSummary(token, token.info.description);

        expect(text(win, '#market-price-coin')).to.equal('2.00000000 TLTC');
        expect(text(win, '#market-floor-coin')).to.equal('1.00000000 TLTC');
        expect(text(win, '#market-marketcap-coin')).to.equal('6.00000000 TLTC');
        ['#market-price-coin', '#market-floor-coin', '#market-marketcap-coin']
            .forEach(function(selector){
                expect(text(win, selector).match(/TLTC/g), selector).to.have.length(1);
                const rowText = win.jQuery(selector).closest('tr').text();
                expect(rowText.match(/TLTC/g), selector + ' row').to.have.length(1);
            });
    });
});
