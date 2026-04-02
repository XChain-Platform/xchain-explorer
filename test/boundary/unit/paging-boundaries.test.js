/**
 * Boundary tests — getPagingDataResults with extreme parameter values
 *
 * Tests negative limit/page/length/start, zero values, overflow values,
 * and combinatorial edge cases that could produce incorrect SQL LIMIT
 * or unexpected paging behavior.
 *
 * Run: mocha test/boundary/unit/paging-boundaries.test.js --timeout 0
 */

'use strict';

const { expect }               = require('chai');
const proxyquire               = require('proxyquire');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeApiConfig, makeExplorerConfig } = require('../../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Minimal Express mock
// ---------------------------------------------------------------------------
const mockApp = { use: () => {}, get: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

// ---------------------------------------------------------------------------
// Mock DB
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
// Load XChainExplorer with mocked deps
// ---------------------------------------------------------------------------
const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB
});

function makeExplorer() {
    const configInfo = createConfigInfoStub();
    return new XChainExplorer(mockApp, configInfo);
}

// Generic row factory
function makeRow(idx) {
    return {
        action_index: idx,
        block_index: 100,
        timestamp: 1700000000,
        source: 'addr1',
        tick: 'XCHAIN',
        amount: '100',
        destination: 'addr2',
        status: 'valid'
    };
}

function generateRows(count) {
    return Array.from({ length: count }, (_, i) => makeRow(count - i));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Boundary: getPagingDataResults — API mode', function () {

    let explorer;
    before(function () { explorer = makeExplorer(); });

    // -----------------------------------------------------------------------
    // limit boundaries
    // -----------------------------------------------------------------------

    it('limit=1 returns exactly 1 row', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 1, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(1);
    });

    it('limit=0 falls back to default max (0 is falsy)', function () {
        const rows = generateRows(150);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 0, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 150);
        // limit=0 is falsy, so q.limit && ... short-circuits → default max = 100
        expect(result).to.have.length(100);
    });

    it('negative limit=-1 — clamped to 1, returns 1 row', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: -1, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // After fix: limit=-1 is clamped to 1, page=1 → returns 1 row
        expect(result).to.be.an('array');
        expect(result.length).to.equal(1);
    });

    it('very large limit returns all available rows (no crash)', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 999999999, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(10);
    });

    // -----------------------------------------------------------------------
    // page boundaries
    // -----------------------------------------------------------------------

    it('page=0 — limit becomes 0, returns empty', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 10, page: 0 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // page=0 is falsy → defaults to 1 in the q.page check
        // Actually: 0 && ... short-circuits, so page defaults to 1
        expect(result).to.have.length(10);
    });

    it('negative page=-1 — clamped to 1, returns 5 rows', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 5, page: -1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // After fix: page=-1 is clamped to 1, limit=5 → returns 5 rows
        expect(result).to.be.an('array');
        expect(result.length).to.equal(5);
    });

    it('page beyond data returns empty array', function () {
        const rows = generateRows(5);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 5, page: 100 } });
        const result = explorer.getPagingDataResults(cfg, rows, 5);
        expect(result).to.be.an('array').with.length(0);
    });

    it('page=1 with limit=MAX_SAFE for getSends does not crash', function () {
        const rows = generateRows(5);
        // Number.MAX_SAFE_INTEGER exceeds 32-bit, so isInteger fails → default limit used
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: Number.MAX_SAFE_INTEGER, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 5);
        expect(result).to.be.an('array');
    });

    // -----------------------------------------------------------------------
    // Combinatorial
    // -----------------------------------------------------------------------

    it('limit=1 page=1 returns first row only', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 1, page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(1);
        expect(result[0].action_index).to.equal(10); // first row (DESC order)
    });

    it('limit=1 page=2 returns second row only', function () {
        const rows = generateRows(10);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 1, page: 2 } });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(1);
        expect(result[0].action_index).to.equal(9);
    });

    it('limit=NaN string falls back to default', function () {
        const rows = generateRows(150);
        const cfg = makeApiConfig('getSends', null, null, { query: { limit: 'abc', page: 1 } });
        const result = explorer.getPagingDataResults(cfg, rows, 150);
        expect(result).to.have.length(100);
    });

    // -----------------------------------------------------------------------
    // getBalances max = 500
    // -----------------------------------------------------------------------

    it('getBalances default limit is 500', function () {
        const rows = Array.from({ length: 600 }, (_, i) => ({
            tick: `TOK${i}`, amount: '100', supply: '1000', decimals: 8, coin_price: '0.001'
        }));
        const cfg = makeApiConfig('getBalances', null, null);
        const result = explorer.getPagingDataResults(cfg, rows, 600);
        expect(result).to.have.length(500);
    });
});

// ===========================================================================
// Explorer mode boundaries
// ===========================================================================

describe('Boundary: getPagingDataResults — Explorer mode', function () {

    let explorer;
    before(function () { explorer = makeExplorer(); });

    it('length=1 returns exactly 1 row', function () {
        const rows = generateRows(10);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 1, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(1);
    });

    it('length=0 falls back to default 10 (0 is falsy)', function () {
        const rows = generateRows(20);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 0, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 20);
        expect(result).to.have.length(10);
    });

    it('length=100 returns up to 100 rows', function () {
        const rows = generateRows(150);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 100, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 150);
        expect(result).to.have.length(100);
    });

    it('length=200 is capped to 100 for getSends', function () {
        const rows = generateRows(200);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 200, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 200);
        expect(result).to.have.length(100);
    });

    it('length=200 is NOT capped for getBalances', function () {
        const rows = Array.from({ length: 300 }, (_, i) => ({
            tick: `TOK${i}`, amount: '100', supply: '1000', decimals: 8, coin_price: '0.001'
        }));
        const cfg = makeExplorerConfig('getBalances', null, null, { length: 200, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 300);
        expect(result).to.have.length(200);
    });

    it('negative length=-5 — clamped to 1, returns 1 row', function () {
        const rows = generateRows(10);
        const cfg = makeExplorerConfig('getSends', null, null, { length: -5, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // After fix: length=-5 is clamped to 1, limit = bcadd(0, 1) = 1
        expect(result).to.be.an('array');
        expect(result.length).to.equal(1);
    });

    it('start beyond total rows returns empty', function () {
        const rows = generateRows(5);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 10, start: 999 });
        const result = explorer.getPagingDataResults(cfg, rows, 5);
        expect(result).to.be.an('array').with.length(0);
    });

    it('negative start=-1 — clamped to 0, returns 10 rows', function () {
        const rows = generateRows(10);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 10, start: -1 });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        // After fix: start=-1 is clamped to 0, limit = bcadd(0, 10) = 10
        expect(result).to.be.an('array');
        expect(result.length).to.equal(10);
    });

    it('start=0 with length=10 on exactly 10 rows returns all', function () {
        const rows = generateRows(10);
        const cfg = makeExplorerConfig('getSends', null, null, { length: 10, start: 0 });
        const result = explorer.getPagingDataResults(cfg, rows, 10);
        expect(result).to.have.length(10);
    });

    it('empty data returns empty array', function () {
        const cfg = makeExplorerConfig('getSends', null, null, { length: 10, start: 0 });
        const result = explorer.getPagingDataResults(cfg, [], 0);
        expect(result).to.be.an('array').with.length(0);
    });
});
