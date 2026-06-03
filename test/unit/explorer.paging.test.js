'use strict';

/**
 * Unit tests for XChainExplorer.getPagingDataResults(config, data, total)
 */

const { expect }             = require('chai');
const proxyquire             = require('proxyquire');
const Utility                = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, makeApiConfig, makeExplorerConfig } = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Minimal Express mock — just enough for XChainExplorer constructor
// ---------------------------------------------------------------------------
const mockApp = { use: () => {}, get: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

// ---------------------------------------------------------------------------
// Mock DB — getMaxMethodResults returns realistic values
// ---------------------------------------------------------------------------
class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults(method) {
        const map = { getBalances: 500, getHolders: 500 };
        return map[method] !== undefined ? map[method] : 100;
    }
}

// ---------------------------------------------------------------------------
// Load XChainExplorer with mocked dependencies
// ---------------------------------------------------------------------------
const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB
});

// ---------------------------------------------------------------------------
// Helper: build a minimal explorer instance without hitting network/fs
// ---------------------------------------------------------------------------
function makeExplorer() {
    const configInfo = createConfigInfoStub();
    const explorer   = new XChainExplorer(mockApp, configInfo);
    return explorer;
}

// ---------------------------------------------------------------------------
// Data factories
// ---------------------------------------------------------------------------

// Generic send row
function makeSend(overrides = {}) {
    return Object.assign({
        action_index: 1,
        block_index:  500,
        timestamp:    1700000000,
        source:       'addr1',
        tick:         'XCHAIN',
        amount:       '100',
        destination:  'addr2',
        status:       'valid'
    }, overrides);
}

// Generic balance row
function makeBalance(overrides = {}) {
    return Object.assign({
        tick:       'XCHAIN',
        amount:     '1000.00000000',
        supply:     '21000000.00000000',
        decimals:   8,
        coin_price: '0.00010000'
    }, overrides);
}

// Generic holder row
function makeHolder(overrides = {}) {
    return Object.assign({
        address:    'addr1',
        amount:     '5000.00000000',
        supply:     '21000000.00000000',
        decimals:   8,
        coin_price: '0.00010000'
    }, overrides);
}

// Generic address row
function makeAddress(overrides = {}) {
    return Object.assign({
        action_index:   10,
        block_index:    500,
        timestamp:      1700000000,
        source:         'addr1',
        fee_preference: 'standard',
        require_memo:   0,
        dispenser_preference: 2,
        status:         'valid'
    }, overrides);
}

// Generic issue row
function makeIssue(overrides = {}) {
    return Object.assign({
        action_index:     50,
        block_index:      400,
        timestamp:        1699000000,
        source:           'addr1',
        tick:             'NEWTOKEN',
        max_supply:       '1000000',
        max_mint:         '100',
        status:           'valid',
        lock_max_supply:  '0',
        lock_mint:        '0',
        lock_mint_supply: '0',
        lock_max_mint:    '0',
        lock_description: '0',
        lock_sleep:       '0',
        lock_callback:    '0'
    }, overrides);
}

// Generic block row — actions sub-object matches the 26-field array
function makeBlock(overrides = {}) {
    return Object.assign({
        block_index: 500,
        timestamp:   1700000000,
        actions: {
            addresses:     1, airdrops:     0, batches:       0, broadcasts:    2,
            callbacks:     0, destroys:     0, dispensers:    1, dispenses:     0,
            dividends:     0, files:        0, issues:        3, links:         0,
            lists:         0, messages:     0, mints:         5, orders:        2,
            order_cancels: 0, order_edits:  0, order_matches: 1, sends:        10,
            sleeps:        0, swaps:        0, swap_cancels:  0, swap_edits:    0,
            swap_matches:  0, sweep:        0
        }
    }, overrides);
}

// ---------------------------------------------------------------------------
// Helpers to convert mathjs BigNumber results to plain JS numbers/strings
// ---------------------------------------------------------------------------
function toNum(v) { return Number(v); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XChainExplorer.getPagingDataResults', function () {

    let explorer;

    before(function () {
        explorer = makeExplorer();
    });

    // -----------------------------------------------------------------------
    // API PAGINATION
    // -----------------------------------------------------------------------

    describe('API pagination', function () {

        it('page 1 with default limit (100) returns all rows passed (SQL handles pagination)', function () {
            // SQL OFFSET now limits rows — getPagingDataResults receives only the current page
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

        it('empty data returns empty array', function () {
            const cfg    = makeApiConfig('getSends', null, null);
            const result = explorer.getPagingDataResults(cfg, [], 0);
            expect(result).to.be.an('array').that.is.empty;
        });

    });

    // -----------------------------------------------------------------------
    // EXPLORER PAGINATION
    // -----------------------------------------------------------------------

    describe('Explorer pagination', function () {

        it('start=0 length=10 returns first 10 rows', function () {
            const rows = Array.from({ length: 20 }, (_, i) => makeSend({ action_index: 20 - i }));
            const cfg  = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, rows, 20);
            expect(result).to.have.length(10);
        });

        it('start=10 length=10 returns rows 11–20', function () {
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

        it('empty data returns empty array for explorer type', function () {
            const cfg    = makeExplorerConfig('getSends', null, null, { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, [], 0);
            expect(result).to.be.an('array').that.is.empty;
        });

    });

    // -----------------------------------------------------------------------
    // COUNT NUMBERING AND count_reverse
    // -----------------------------------------------------------------------

    describe('count and count_reverse numbering', function () {

        it('count_reverse = total - (count - 1) for first row (count=1, total=50)', function () {
            // start=0, first row → count=1, count_reverse = 50 - (1-1) = 50
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

    // -----------------------------------------------------------------------
    // PREV / LAST REVERSAL
    // -----------------------------------------------------------------------

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
            // Reversed → last item comes first
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

    // -----------------------------------------------------------------------
    // STATUS CONVERSION
    // -----------------------------------------------------------------------

    describe('status conversion (valid → 1, else → 0)', function () {

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

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getSends
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getBalances
    // -----------------------------------------------------------------------

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
            // percent = (1000 / 21000000) * 100 ≈ 0.00476190...
            expect(parseFloat(r[3])).to.be.closeTo(0.004761904761, 0.000001);
            // value = 1000 * 0.0001 = 0.1
            expect(parseFloat(r[4])).to.be.closeTo(0.1, 0.000001);
            expect(r[5]).to.be.null;
        });

    });

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getHolders
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getBlocks
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getIssues
    // -----------------------------------------------------------------------

    describe('method: getIssues', function () {

        it('formats result with pipe-joined locks at index 7', function () {
            const row = makeIssue();
            const cfg    = makeExplorerConfig('getIssues', null, null, { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, [row], 1);
            const r = result[0];
            // getIssues: [count_reverse, block_index, timestamp, source, tick, max_supply, max_mint, locks, status, action_index]
            expect(r).to.be.an('array').with.length(10);
            // locks = lock_max_supply|lock_mint|lock_mint_supply|lock_max_mint|lock_description|lock_sleep|lock_callback
            expect(r[7]).to.equal('0|0|0|0|0|0|0');
            expect(r[8]).to.equal(1); // valid
        });

        it('getTokens also includes pipe-joined locks', function () {
            const row = Object.assign(makeIssue(), {
                supply: '500000',
                id:     'someId'
            });
            const cfg    = makeExplorerConfig('getTokens', null, null, { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, [row], 1);
            const r = result[0];
            // getTokens: [count_reverse, block_index, timestamp, tick, supply, max_supply, max_mint, locks, id]
            expect(r).to.be.an('array').with.length(9);
            expect(r[7]).to.equal('0|0|0|0|0|0|0');
        });

    });

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getAddresses
    // -----------------------------------------------------------------------

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
            expect(r[7]).to.equal(1);  // valid → 1
            expect(r[8]).to.equal(99);
        });

    });

    // -----------------------------------------------------------------------
    // METHOD-SPECIFIC FORMATTING: getSearch
    // -----------------------------------------------------------------------

    describe('method: getSearch', function () {

        it('getSearch extracts data.data before processing', function () {
            // The method unwraps data.data when method==getSearch
            const rows = [{ address: 'foundAddr1' }, { address: 'foundAddr2' }];
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 2);
            expect(result).to.have.length(2);
        });

        it('search type=address returns [count, address, null]', function () {
            const rows = [{ address: 'myAddr' }];
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 1);
            const r = result[0];
            expect(r).to.deep.equal([result[0][0], 'myAddr', null]);
            expect(toNum(r[0])).to.equal(1);
        });

        it('search type=broadcast returns [count, message, memo, action_index]', function () {
            const rows = [{ message: 'hello world', memo: 'some memo', action_index: 7 }];
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'broadcast', { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 1);
            const r = result[0];
            expect(r).to.be.an('array').with.length(4);
            expect(r[1]).to.equal('hello world');
            expect(r[2]).to.equal('some memo');
            expect(r[3]).to.equal(7);
        });

        it('search type=token returns [count, tick, description, null]', function () {
            const rows = [{ tick: 'XCHAIN', description: 'Gas Token' }];
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'token', { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 1);
            const r = result[0];
            expect(r).to.be.an('array').with.length(4);
            expect(r[1]).to.equal('XCHAIN');
            expect(r[2]).to.equal('Gas Token');
            expect(r[3]).to.be.null;
        });

        it('search type=transaction returns [count, hash, null]', function () {
            const rows = [{ hash: 'txhash123' }];
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'transaction', { start: 0, length: 10 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 1);
            const r = result[0];
            expect(r).to.be.an('array').with.length(3);
            expect(r[1]).to.equal('txhash123');
            expect(r[2]).to.be.null;
        });

        it('getSearch with multiple results paginates correctly', function () {
            const rows = Array.from({ length: 15 }, (_, i) => ({ address: `addr${i}` }));
            const wrapper = { data: rows };
            const cfg = makeExplorerConfig('getSearch', null, 'address', { start: 5, length: 5 });
            const result = explorer.getPagingDataResults(cfg, wrapper, 15);
            expect(result).to.have.length(5);
        });

    });

});
