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

describe('API pagination', function () {
    it('page 1 with default limit (100) returns all rows passed (SQL handles pagination)', function () {
        // SQL OFFSET limits rows; getPagingDataResults receives only the current page
        const rows = Array.from({ length: 100 }, (_, i) => makeSend({ action_index: 100 - i }));
        const cfg  = makeApiConfig('getSends', null, null);
        const result = explorer.getPagingDataResults(cfg, rows, 150);
        expect(result).to.have.length(100);
    });

    it('page 1 with default limit returns all items when data is fewer than limit', function () {
        const rows = [makeSend({ action_index: 5 }), makeSend({ action_index: 4 })];
        const cfg  = makeApiConfig('getSends', null, null);
        const result = explorer.getPagingDataResults(cfg, rows, 2);
        expect(result).to.have.length(2);
    });

    it('page 3 with limit 10 returns all rows passed (SQL already applied OFFSET)', function () {
        // SQL OFFSET returns rows 21-30, so only 10 rows arrive here
        const rows = Array.from({ length: 10 }, (_, i) => makeSend({ action_index: 30 - i }));
        const cfg  = makeApiConfig('getSends', null, null, { query: { page: 3, limit: 10 } });
        const result = explorer.getPagingDataResults(cfg, rows, 35);
        expect(result).to.have.length(10);
    });

    it('page 2 with limit 5 returns all rows passed (SQL already applied OFFSET)', function () {
        // SQL OFFSET returns rows 6-10, so only 5 rows arrive here
        const rows = Array.from({ length: 5 }, (_, i) => makeSend({ action_index: 10 - i }));
        const cfg  = makeApiConfig('getSends', null, null, { query: { page: 2, limit: 5 } });
        const result = explorer.getPagingDataResults(cfg, rows, 15);
        expect(result).to.have.length(5);
    });

    it('last page returns only remaining rows (SQL already applied OFFSET)', function () {
        // SQL OFFSET returns rows 11-12, so only 2 rows arrive here
        const rows = Array.from({ length: 2 }, (_, i) => makeSend({ action_index: 2 - i }));
        const cfg  = makeApiConfig('getSends', null, null, { query: { page: 2, limit: 10 } });
        const result = explorer.getPagingDataResults(cfg, rows, 12);
        expect(result).to.have.length(2);
    });

    it('returns raw row objects (not arrays) for API getSends', function () {
        const rows = [makeSend()];
        const cfg  = makeApiConfig('getSends', null, null);
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(result[0]).to.be.an('object').and.not.an('array');
    });

    it('API getHolders strips all fields except address and amount', function () {
        const rows = [makeHolder()];
        const cfg  = makeApiConfig('getHolders', null, null);
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(result[0]).to.deep.equal({ address: 'addr1', amount: '5000.00000000' });
    });
});

describe('API pagination', function () {
    it('empty data returns empty array', function () {
        const cfg    = makeApiConfig('getSends', null, null);
        const result = explorer.getPagingDataResults(cfg, [], 0);
        expect(result).to.be.an('array').that.is.empty;
    });

});

describe('Explorer pagination', function () {
    it('start=0 length=10 returns first 10 rows', function () {
        const rows = Array.from({ length: 20 }, (_, i) => makeSend({ action_index: 20 - i }));
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 20);
        expect(result).to.have.length(10);
    });

    it('start=10 length=10 returns rows 11-20', function () {
        const rows = Array.from({ length: 25 }, (_, i) => makeSend({ action_index: 25 - i }));
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 10, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 25);
        expect(result).to.have.length(10);
    });

    it('length > 100 is capped to 100 for standard methods', function () {
        const rows = Array.from({ length: 200 }, (_, i) => makeSend({ action_index: 200 - i }));
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 150 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        // length is capped to 100, limit = start(0) + 100 = 100
        expect(result).to.have.length(100);
    });

    it('length > 100 is NOT capped for getHolders', function () {
        const rows = Array.from({ length: 200 }, (_, i) => makeHolder({ address: `addr${i}` }));
        const cfg  = makeExplorerConfig('getHolders', null, null, { start: 0, length: 150 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        // limit = start(0) + length(150) = 150, no cap
        expect(result).to.have.length(150);
    });

    it('length > 100 is NOT capped for getBalances', function () {
        const rows = Array.from({ length: 200 }, (_, i) => makeBalance({ tick: `TOKEN${i}` }));
        const cfg  = makeExplorerConfig('getBalances', null, null, { start: 0, length: 120 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        expect(result).to.have.length(120);
    });

    it('length > 100 is NOT capped for getCredits', function () {
        const rows = Array.from({ length: 200 }, (_, i) => ({
            action_index: i, block_index: 500, timestamp: 1700000000,
            address: `addr${i}`, tick: 'XCHAIN', amount: '10', action: 'SEND'
        }));
        const cfg  = makeExplorerConfig('getCredits', null, null, { start: 0, length: 110 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        expect(result).to.have.length(110);
    });

    it('length > 100 is NOT capped for getDebits', function () {
        const rows = Array.from({ length: 200 }, (_, i) => ({
            action_index: i, block_index: 500, timestamp: 1700000000,
            address: `addr${i}`, tick: 'XCHAIN', amount: '10', action: 'SEND'
        }));
        const cfg  = makeExplorerConfig('getDebits', null, null, { start: 0, length: 110 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        expect(result).to.have.length(110);
    });
});

describe('Explorer pagination', function () {
    it('empty data returns empty array for explorer type', function () {
        const cfg    = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [], 0);
        expect(result).to.be.an('array').that.is.empty;
    });

});

describe('count and count_reverse numbering', function () {

    it('count_reverse = total - (count - 1) for first row (count=1, total=50)', function () {
        // start=0, first row -> count=1, count_reverse = 50 - (1-1) = 50
        const rows = [makeSend({ action_index: 100 })];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 50);
        // getSends format: [count_reverse, block_index, timestamp, source, tick, amount, destination, status, action_index]
        expect(toNum(result[0][0])).to.equal(50);
    });

    it('count_reverse for second row decrements by 1', function () {
        const rows = [
            makeSend({ action_index: 100 }),
            makeSend({ action_index: 99 })
        ];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 50);
        // row 1: count=1, count_reverse=50; row 2: count=2, count_reverse=49
        expect(toNum(result[0][0])).to.equal(50);
        expect(toNum(result[1][0])).to.equal(49);
    });

    it('count_reverse uses total=1 for a single row dataset', function () {
        const rows = [makeSend({ action_index: 1 })];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(toNum(result[0][0])).to.equal(1);
    });

    it('getBalances uses ascending count (not count_reverse) at index 0', function () {
        const rows = [makeBalance({ tick: 'XCHAIN' }), makeBalance({ tick: 'PEPE' })];
        const cfg  = makeExplorerConfig('getBalances', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 100);
        // count for row1 = 1, row2 = 2
        expect(toNum(result[0][0])).to.equal(1);
        expect(toNum(result[1][0])).to.equal(2);
    });

    it('getHolders uses ascending count at index 0', function () {
        const rows = [makeHolder({ address: 'addr1' }), makeHolder({ address: 'addr2' })];
        const cfg  = makeExplorerConfig('getHolders', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 2);
        expect(toNum(result[0][0])).to.equal(1);
        expect(toNum(result[1][0])).to.equal(2);
    });

});

describe('prev/last action reversal', function () {

    it('action=prev reverses result order', function () {
        const rows = [
            makeSend({ action_index: 10 }),
            makeSend({ action_index: 9 }),
            makeSend({ action_index: 8 })
        ];
        const cfg = makeExplorerConfig('getSends', null, null, {
            start:  0,
            length: 10,
            action: 'prev'
        });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // Reversed: last item comes first
        // Each row's action_index is at position [8]
        expect(toNum(result[0][8])).to.equal(8);
        expect(toNum(result[2][8])).to.equal(10);
    });

    it('action=last reverses result order', function () {
        const rows = [
            makeSend({ action_index: 10 }),
            makeSend({ action_index: 9 })
        ];
        const cfg = makeExplorerConfig('getSends', null, null, {
            start:  0,
            length: 10,
            action: 'last'
        });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(toNum(result[0][8])).to.equal(9);
        expect(toNum(result[1][8])).to.equal(10);
    });

    it('action=next does NOT reverse results', function () {
        const rows = [
            makeSend({ action_index: 10 }),
            makeSend({ action_index: 9 })
        ];
        const cfg = makeExplorerConfig('getSends', null, null, {
            start:  0,
            length: 10,
            action: 'next'
        });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(toNum(result[0][8])).to.equal(10);
        expect(toNum(result[1][8])).to.equal(9);
    });

});

describe('status conversion (valid => 1, else => 0)', function () {

    it('status=valid maps to 1 in getSends', function () {
        const rows = [makeSend({ status: 'valid' })];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        // getSends: [count_reverse, block_index, timestamp, source, tick, amount, destination, status, action_index]
        expect(result[0][7]).to.equal(1);
    });

    it('status=invalid maps to 0 in getSends', function () {
        const rows = [makeSend({ status: 'invalid' })];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(result[0][7]).to.equal(0);
    });

    it('status=pending maps to 0 in getSends', function () {
        const rows = [makeSend({ status: 'pending' })];
        const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(result[0][7]).to.equal(0);
    });

    it('status=valid maps to 1 in getAddresses', function () {
        const rows = [makeAddress({ status: 'valid' })];
        const cfg  = makeExplorerConfig('getAddresses', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        // getAddresses: [count_reverse, block_index, timestamp, source, fee_preference, require_memo, dispenser_preference, status, action_index]
        expect(result[0][7]).to.equal(1);
    });

    it('status=invalid maps to 0 in getAddresses', function () {
        const rows = [makeAddress({ status: 'invalid' })];
        const cfg  = makeExplorerConfig('getAddresses', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, rows, 1);
        expect(result[0][7]).to.equal(0);
    });

});
