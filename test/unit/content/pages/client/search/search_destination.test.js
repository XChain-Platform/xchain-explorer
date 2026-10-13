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
 * What a search query resolves to: an address, a transaction hash, a block
 * height or an action index opens that record's page, and anything else stays
 * a token search. The search feed only matches tokens, so a query that names a
 * record and is NOT routed here renders "No records found" on a record that
 * exists.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { bootClient } = require('./support/boot');

const HASH     = 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d';
const BTC_P2PKH  = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const BTC_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const TBTC_BECH32 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('search destination by query class', () => {

    let win;
    beforeEach(() => { ({ win } = bootClient('https://xchain.test/BTC/search')); });

    it('uses address fixtures the client itself accepts for their own coin', () => {
        expect(win.isCryptoAddress(BTC_P2PKH, 'BTC', 'mainnet')).to.equal(true);
        expect(win.isCryptoAddress(BTC_BECH32, 'BTC', 'mainnet')).to.equal(true);
        expect(win.isCryptoAddress(TBTC_BECH32, 'BTC', 'testnet')).to.equal(true);
    });

    it('sends a valid address for the coin to its address page', () => {
        expect(win.searchDestination(BTC_P2PKH, 'BTC', 900000)).to.equal('/BTC/address/' + BTC_P2PKH);
        expect(win.searchDestination(BTC_BECH32, 'BTC', null)).to.equal('/BTC/address/' + BTC_BECH32);
        expect(win.searchDestination(TBTC_BECH32, 'TBTC', null)).to.equal('/TBTC/address/' + TBTC_BECH32);
    });

    it('validates the address against the searched coin, not the page coin', () => {
        // A mainnet address searched on another network is not that network's
        // address, so it falls back to the token search rather than a dead page.
        expect(win.searchDestination(BTC_P2PKH, 'LTC', null)).to.equal(null);
        expect(win.searchDestination(TBTC_BECH32, 'BTC', null)).to.equal(null);
        expect(win.searchDestination(BTC_BECH32, 'TBTC', null)).to.equal(null);
    });

    it('sends a 64-hex string to the transaction page, all-digit or not', () => {
        expect(win.searchDestination(HASH, 'TBTC', 156400)).to.equal('/TBTC/transaction/' + HASH);
        expect(win.searchDestination(HASH.toUpperCase(), 'TBTC', null)).to.equal('/TBTC/transaction/' + HASH.toUpperCase());
        const digits = '1'.repeat(64);
        expect(win.searchDestination(digits, 'TBTC', 156400)).to.equal('/TBTC/transaction/' + digits);
    });

    it('sends a number at or below the tip to the block page', () => {
        expect(win.searchDestination('156304', 'TBTC', 156400)).to.equal('/TBTC/block/156304');
        expect(win.searchDestination('156400', 'TBTC', 156400)).to.equal('/TBTC/block/156400');
        expect(win.searchDestination('0', 'TBTC', 156400)).to.equal('/TBTC/block/0');
    });

    it('sends a number above the tip to the action page', () => {
        expect(win.searchDestination('156401', 'TBTC', 156400)).to.equal('/TBTC/action/156401');
        expect(win.searchDestination('9000000', 'TBTC', '156400')).to.equal('/TBTC/action/9000000');
    });

    it('keeps a number on the block page when the tip is unknown', () => {
        for(const tip of [null, undefined, '', 'n/a'])
            expect(win.searchDestination('9000000', 'TBTC', tip), String(tip)).to.equal('/TBTC/block/9000000');
    });

    it('trims surrounding whitespace before classifying', () => {
        expect(win.searchDestination('  156304 ', 'TBTC', 156400)).to.equal('/TBTC/block/156304');
        expect(win.searchDestination(' ' + HASH + '\n', 'TBTC', null)).to.equal('/TBTC/transaction/' + HASH);
    });

    it('leaves token text, partial hashes and empty input as a token search', () => {
        for(const q of ['XCHAIN', 'campa', 'A12', HASH.slice(0, 63), HASH + 'f', '12.5', '-3', '', '   ', null, undefined])
            expect(win.searchDestination(q, 'BTC', 900000), String(q)).to.equal(null);
    });

    it('returns null for a coin this client does not know', () => {
        expect(win.searchDestination('156304', 'XYZ', 156400)).to.equal(null);
    });

});

describe('search tip and query parameters', () => {

    let win;
    beforeEach(() => { ({ win } = bootClient('https://xchain.test/BTC/search')); });

    it('reads the tip for the coin from a /status body', () => {
        const status = { last_block: { TBTC: 156400, BTC: '900000' } };
        expect(win.searchTip(status, 'TBTC')).to.equal(156400);
        expect(win.searchTip(status, 'btc')).to.equal(900000);
        expect(win.searchTip(status, 'LTC')).to.equal(null);
        expect(win.searchTip({ last_block: { TBTC: null } }, 'TBTC')).to.equal(null);
        expect(win.searchTip(null, 'TBTC')).to.equal(null);
    });

    it('accepts ?q= as an alias of ?query=, with ?query= winning', () => {
        const read = (s) => win.searchQueryParam(new win.URLSearchParams(s));
        expect(read('?query=CAMPA')).to.equal('CAMPA');
        expect(read('?q=CAMPA')).to.equal('CAMPA');
        expect(read('?query=ONE&q=TWO')).to.equal('ONE');
        expect(read('?query=&q=TWO')).to.equal('TWO');
        expect(read('?coin=BTC')).to.equal(null);
    });

});

describe('search destination with a live tip', () => {

    // getExplorerStatusInfo answers from the cached /status unless forced; the
    // stub records each call's force flag and answers with the next body.
    function withStatus(win, bodies){
        const calls = [];
        win.getExplorerStatusInfo = function(cb, force){
            calls.push(force === true);
            cb(bodies[Math.min(calls.length - 1, bodies.length - 1)]);
        };
        return calls;
    }

    function resolve(win, coin, query){
        let out;
        win.resolveSearchDestination(coin, query, (dest) => { out = dest; });
        return out;
    }

    it('decides addresses and hashes without reading the status', () => {
        const { win } = bootClient('https://xchain.test/BTC/search');
        const calls = withStatus(win, []);
        expect(resolve(win, 'BTC', BTC_P2PKH)).to.equal('/BTC/address/' + BTC_P2PKH);
        expect(resolve(win, 'TBTC', HASH)).to.equal('/TBTC/transaction/' + HASH);
        expect(resolve(win, 'BTC', 'CAMPA')).to.equal(null);
        expect(calls).to.deep.equal([]);
    });

    it('opens a block at or below the cached tip with one status read', () => {
        const { win } = bootClient('https://xchain.test/TBTC/search');
        const calls = withStatus(win, [{ last_block: { TBTC: 156400 } }]);
        expect(resolve(win, 'TBTC', '156304')).to.equal('/TBTC/block/156304');
        expect(calls).to.deep.equal([false]);
    });

    it('re-reads a fresh tip before calling a number an action index', () => {
        // The cached tip trails the chain: 156402 was mined after it was stored.
        const { win } = bootClient('https://xchain.test/TBTC/search');
        const calls = withStatus(win, [{ last_block: { TBTC: 156400 } }, { last_block: { TBTC: 156405 } }]);
        expect(resolve(win, 'TBTC', '156402')).to.equal('/TBTC/block/156402');
        expect(calls).to.deep.equal([false, true]);
    });

    it('opens the action page when the fresh tip confirms the number is past it', () => {
        const { win } = bootClient('https://xchain.test/TBTC/search');
        withStatus(win, [{ last_block: { TBTC: 156400 } }, { last_block: { TBTC: 156405 } }]);
        expect(resolve(win, 'TBTC', '9000000')).to.equal('/TBTC/action/9000000');
    });

    it('falls back to the cached tip when the fresh read fails', () => {
        const { win } = bootClient('https://xchain.test/TBTC/search');
        withStatus(win, [{ last_block: { TBTC: 156400 } }, null]);
        expect(resolve(win, 'TBTC', '9000000')).to.equal('/TBTC/action/9000000');
    });

    it('opens the block page when no status is available at all', () => {
        const { win } = bootClient('https://xchain.test/TBTC/search');
        withStatus(win, [null]);
        expect(resolve(win, 'TBTC', '9000000')).to.equal('/TBTC/block/9000000');
    });

});
