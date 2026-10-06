'use strict';

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
 **********************************************************************
 * Unit tests for XChainExplorer.getPagingDataResults(config, data, total)
 */

const {
    expect, makeApiConfig, makeExplorerConfig, makeSend, makeBalance, makeHolder,
    makeAddress, makeIssue, makeBlock, toNum, state
} = require('./helpers.js');

let explorer;
before(function () { explorer = state.explorer; });

describe('method: getSends', function () {

    it('formats result as expected 9-element array', function () {
        const row = makeSend({
            action_index: 42,
            block_index:  600,
            timestamp:    1710000000,
            source:       'srcAddr',
            tick:         'PEPE',
            amount:       '250',
            destination:  'dstAddr',
            status:       'valid'
        });
        const cfg    = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 100);
        const r = result[0];
        expect(r).to.be.an('array').with.length(9);
        expect(toNum(r[0])).to.equal(100); // count_reverse = 100 - (1-1) = 100
        expect(r[1]).to.equal(600);
        expect(r[2]).to.equal(1710000000);
        expect(r[3]).to.equal('srcAddr');
        expect(r[4]).to.equal('PEPE');
        expect(r[5]).to.equal('250');
        expect(r[6]).to.equal('dstAddr');
        expect(r[7]).to.equal(1);   // valid
        expect(r[8]).to.equal(42);
    });

});

describe('method: getOrderMatches', function () {

    it('formats the two order legs, amounts and settlement into a 12-element array', function () {
        const row = {
            action_index:      90,
            block_index:       800,
            timestamp:         1730000000,
            give_coin:         'BTC',
            give_action_index: 70,
            give_amount:       '15',
            get_coin:          'LTC',
            get_action_index:  80,
            get_amount:        '30',
            settlement_type:   'TOKEN',
            status:            'valid'
        };
        const cfg    = makeExplorerConfig('getOrderMatches', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(12);
        expect(toNum(r[0])).to.equal(1);
        expect(r[1]).to.equal(800);
        expect(r[2]).to.equal(1730000000);
        expect(r[3]).to.equal('BTC');
        expect(r[4]).to.equal(70);
        expect(r[5]).to.equal('15');
        expect(r[6]).to.equal('LTC');
        expect(r[7]).to.equal(80);
        expect(r[8]).to.equal('30');
        expect(r[9]).to.equal('TOKEN');
        expect(r[r.length - 2]).to.equal(1);  // status stays second-to-last
        expect(r[r.length - 1]).to.equal(90); // action_index stays last (cursor)
    });

});

describe('method: getSwapMatches', function () {

    it('formats the two swap legs into a 9-element array (no amounts, no settlement)', function () {
        const row = {
            action_index:      91,
            block_index:       801,
            timestamp:         1730000001,
            give_coin:         'DOGE',
            give_action_index: 71,
            get_coin:          'BTC',
            get_action_index:  81,
            status:            'invalid'
        };
        const cfg    = makeExplorerConfig('getSwapMatches', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(9);
        expect(r[1]).to.equal(801);
        expect(r[3]).to.equal('DOGE');
        expect(r[4]).to.equal(71);
        expect(r[5]).to.equal('BTC');
        expect(r[6]).to.equal(81);
        expect(r[r.length - 2]).to.equal(0);  // invalid => 0, second-to-last
        expect(r[r.length - 1]).to.equal(91); // action_index stays last (cursor)
    });

});

describe('method: getActions', function () {

    it('formats the raw action list as a 6-element array with the action name second-to-last', function () {
        const row = {
            action_index: 92,
            block_index:  802,
            timestamp:    1730000002,
            source:       'srcAddr',
            action:       'SEND'
        };
        const cfg    = makeExplorerConfig('getActions', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(6);
        expect(r[1]).to.equal(802);
        expect(r[3]).to.equal('srcAddr');
        // No status column on the actions table: the name lands second-to-last
        // and the client keeps this view in its no-color list.
        expect(r[r.length - 2]).to.equal('SEND');
        expect(r[r.length - 1]).to.equal(92); // action_index stays last (cursor)
    });

});

describe('method: getBalances', function () {

    it('formats result as 6-element array with formatted amount, percent, value', function () {
        const row = makeBalance({
            tick:       'XCHAIN',
            amount:     '1000.00000000',
            supply:     '21000000.00000000',
            decimals:   8,
            coin_price: '0.00010000'
        });
        const cfg    = makeExplorerConfig('getBalances', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(6);
        expect(toNum(r[0])).to.equal(1);           // count (ascending)
        expect(r[1]).to.equal('XCHAIN');
        // amount formatted to 8 decimals
        expect(r[2]).to.equal('1000.00000000');
        // percent = (1000 / 21000000) * 100 ~= 0.00476190...
        expect(parseFloat(r[3])).to.be.closeTo(0.004761904761, 0.000001);
        // value = 1000 * 0.0001 = 0.1
        expect(parseFloat(r[4])).to.be.closeTo(0.1, 0.000001);
        expect(r[5]).to.be.null;
    });

});

describe('method: getHolders', function () {

    it('formats result as 6-element array with address, formatted amount, percent, value', function () {
        const row = makeHolder({
            address:    'holderAddr',
            amount:     '5000.00000000',
            supply:     '21000000.00000000',
            decimals:   8,
            coin_price: '0.00010000'
        });
        const cfg    = makeExplorerConfig('getHolders', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(6);
        expect(toNum(r[0])).to.equal(1);
        expect(r[1]).to.equal('holderAddr');
        expect(r[2]).to.equal('5000.00000000');
        expect(parseFloat(r[3])).to.be.closeTo(0.023809523, 0.000001);
        expect(parseFloat(r[4])).to.be.closeTo(0.5, 0.000001);
        expect(r[5]).to.be.null;
    });

});

describe('method: getBlocks', function () {

    it('formats result as 4-element array with pipe-joined actions string', function () {
        const row = makeBlock({ block_index: 700, timestamp: 1720000000 });
        const cfg    = makeExplorerConfig('getBlocks', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        expect(r).to.be.an('array').with.length(4);
        expect(r[0]).to.equal(700);  // block_index
        expect(r[1]).to.equal(1720000000);
        // actions string: 26 fields joined by pipe
        const parts = r[2].split('|');
        expect(parts).to.have.length(26);
        expect(parts[0]).to.equal('1');   // addresses
        expect(parts[3]).to.equal('2');   // broadcasts
        expect(parts[10]).to.equal('3');  // issues
        expect(r[3]).to.equal(700);       // block_index repeated
    });

});

describe('method: getIssues', function () {

    it('formats result with pipe-joined locks at index 7', function () {
        const row = makeIssue();
        const cfg    = makeExplorerConfig('getIssues', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        // getIssues: [count_reverse, block_index, timestamp, source, tick, max_supply, max_mint, locks, transfer, status, action_index]
        // (transfer sits BEFORE status/action_index so the client's
        // length-relative status + paging-offset extraction keeps working)
        expect(r).to.be.an('array').with.length(11);
        // locks = lock_max_supply|lock_mint|lock_mint_supply|lock_max_mint|lock_description|lock_sleep|lock_callback
        expect(r[7]).to.equal('0|0|0|0|0|0|0');
        expect(r[r.length - 2]).to.equal(1); // valid (status stays second-to-last)
    });

    it('getTokens also includes pipe-joined locks and trailing decimals + id', function () {
        const row = Object.assign(makeIssue(), {
            supply:   '500000',
            decimals: 0,
            id:       'someId'
        });
        const cfg    = makeExplorerConfig('getTokens', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 1);
        const r = result[0];
        // getTokens: [count_reverse, block_index, timestamp, tick, supply, max_supply, max_mint, locks, decimals, id]
        // decimals + locks let clients badge NFT-pattern tokens; id must stay
        // LAST (the datatables client uses the last element for offset paging)
        expect(r).to.be.an('array').with.length(10);
        expect(r[7]).to.equal('0|0|0|0|0|0|0');
        expect(r[8]).to.equal(0);        // decimals
        expect(r[9]).to.equal('someId'); // id stays the trailing element
    });

});

describe('method: getAddresses', function () {

    it('formats result as 9-element array', function () {
        const row = makeAddress({
            action_index:   99,
            block_index:    800,
            timestamp:      1730000000,
            source:         'srcAddr',
            fee_preference: 'high',
            require_memo:   1,
            dispenser_preference: 1,
            status:         'valid'
        });
        const cfg    = makeExplorerConfig('getAddresses', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [row], 200);
        const r = result[0];
        expect(r).to.be.an('array').with.length(9);
        expect(toNum(r[0])).to.equal(200); // count_reverse
        expect(r[1]).to.equal(800);
        expect(r[2]).to.equal(1730000000);
        expect(r[3]).to.equal('srcAddr');
        expect(r[4]).to.equal('high');
        expect(r[5]).to.equal(1);
        expect(r[6]).to.equal(1);  // dispenser_preference (owner only)
        expect(r[7]).to.equal(1);  // valid -> 1
        expect(r[8]).to.equal(99);
    });

});
