/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../..');
const SRC = fs.readFileSync(
    path.join(ROOT, 'src/content/js/xchain/detail_anchor_price.js'), 'utf8');

function extractFn(name){
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    let end = braceStart;
    for(; end < SRC.length; end++){
        if(SRC[end] === '{') depth++;
        else if(SRC[end] === '}' && --depth === 0) return SRC.slice(start, end + 1);
    }
    throw new Error('function not closed: ' + name);
}

function newCell(selector){
    return {
        html: '',
        text: '',
        classes: new Set(selector.endsWith('-row') ? ['d-none'] : [])
    };
}

function helperHarness(name){
    const cells = new Map();
    const cell = (selector) => {
        if(!cells.has(selector)) cells.set(selector, newCell(selector));
        return cells.get(selector);
    };
    const $ = (selector) => {
        const selected = selector.split(',').map((part) => cell(part.trim()));
        const api = {
            html(value){ selected.forEach((item) => { item.html = value; }); return api; },
            text(value){ selected.forEach((item) => { item.text = String(value); }); return api; },
            toggleClass(className, enabled){
                selected.forEach((item) => enabled ? item.classes.add(className) : item.classes.delete(className));
                return api;
            },
            removeClass(className){ selected.forEach((item) => item.classes.delete(className)); return api; }
        };
        return api;
    };
    const context = vm.createContext({
        $,
        isNull: (value) => value === null || value === undefined || value === '',
        tokenUrl: (coin, tick) => '/' + coin + '/token/' + tick,
        formatLink: (href, text) => '<a href="' + href + '">' + text + '</a>',
        formatHash: (value, length) => String(value).substring(0, length),
        numeral: (value) => ({
            format: (pattern) => pattern === '0,0.[000000]'
                ? String(Number(value)) : Number(value).toLocaleString('en-US')
        })
    });
    vm.runInContext(extractFn(name), context);
    return { context, cell };
}

describe('PRICE detail helpers', function(){
    it('renders the scalar PRICE fields without changing their display forms', function(){
        const { context, cell } = helperHarness('showPriceFields');
        context.showPriceFields({
            version: 1, coin: 'LTC', tick: 'PEPE', fiat: 'USD', value: '0.00042',
            oracle_fee: '0.01', round_number: 1234
        });

        assert.strictEqual(cell('#info-price .price-version').html,
            '<span class="badge text-bg-primary">User (v1)</span>');
        assert.strictEqual(cell('#info-price .price-coin').text, 'LTC');
        assert.strictEqual(cell('#info-price .price-ticker').html,
            '<a href="/LTC/token/PEPE">PEPE</a>');
        assert.strictEqual(cell('#info-price .price-fiat').text, 'USD');
        assert.strictEqual(cell('#info-price .price-value').text, '0.00042');
        assert.strictEqual(cell('#info-price .price-oracle-fee').text, '0.01 (1%)');
        assert.strictEqual(cell('#info-price .price-round').text, '1,234');
    });

    it('renders batch window and pair width fallbacks', function(){
        const { context, cell } = helperHarness('showPriceBatch');
        const rounds = [{ pairs: [{}, {}] }, { pairs: [{}] }];
        context.showPriceBatch({
            batch_first_round: 414, batch_last_round: 415, round_count: null,
            round_timestamp: 1743638400, pairs: null, pair_count: null
        }, rounds);

        assert.strictEqual(cell('#info-price .price-window-row').classes.has('d-none'), false);
        assert.strictEqual(cell('#info-price .price-window').text, '414 - 415 (2 rounds)');
        assert.strictEqual(cell('#info-price .price-round-timestamp').text, '1743638400');
        assert.strictEqual(cell('#info-price .price-pairs').text, '2 per round');
    });

    it('keeps explicit pair data ahead of batch fallbacks', function(){
        const { context, cell } = helperHarness('showPriceBatch');
        context.showPriceBatch({
            batch_first_round: null, batch_last_round: null,
            pairs: [{}, {}, {}], pair_count: 8
        }, [{ pairs: [{}] }]);

        assert.strictEqual(cell('#info-price .price-window-row').classes.has('d-none'), true);
        assert.strictEqual(cell('#info-price .price-pairs').text, '3');
    });
});

describe('PRICE signature helper', function(){
    it('renders signature count and signer hashes', function(){
        const { context, cell } = helperHarness('showPriceSignatures');
        context.showPriceSignatures({ sig_count: null }, [
            { pubkey: 'a'.repeat(32) },
            { pubkey: 'b'.repeat(32) }
        ]);

        assert.strictEqual(cell('#info-price .price-sig-count').text, '2');
        assert.strictEqual(cell('#info-price .price-signers').html,
            'a'.repeat(24) + '<br>' + 'b'.repeat(24));
        assert.strictEqual(cell('#info-price .price-signers-row').classes.has('d-none'), false);
    });

    it('marks unparseable signatures and reveals the signer row', function(){
        const { context, cell } = helperHarness('showPriceSignatures');
        context.showPriceSignatures({ signatures_unparseable: true }, []);

        assert.strictEqual(cell('#info-price .price-sig-count').html,
            '<span class="text-danger">unparseable</span>');
        assert.strictEqual(cell('#info-price .price-signers').html,
            '<span class="text-danger">unparseable</span>');
        assert.strictEqual(cell('#info-price .price-signers-row').classes.has('d-none'), false);
    });
});
