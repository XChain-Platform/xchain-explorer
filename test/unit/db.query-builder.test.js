/**
 * Unit tests for SQL generation functions in src/db.js
 *
 * Tests:
 *   - getMaxMethodResults(method)
 *   - getQueryWhereSql(config)
 *   - getQueryOffsetSql(config)
 */

'use strict';

const { expect }    = require('chai');
const proxyquire    = require('proxyquire');
const Utility       = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Bootstrap: create a Database instance without a real MariaDB connection
// ---------------------------------------------------------------------------

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new Database(mockExplorer);
}

// Helper: build a minimal config for getQueryWhereSql / getQueryOffsetSql
function cfg(method, type, extras = {}) {
    return makeConfig({ data: { method, type, ...extras } });
}

// Helper: build a minimal config with offset data
function cfgOffset(method, action, start, stop) {
    return makeConfig({
        data: {
            method,
            type: null,
            offset: { action, start, stop }
        }
    });
}

// ---------------------------------------------------------------------------
// getMaxMethodResults
// ---------------------------------------------------------------------------

describe('Database#getMaxMethodResults', () => {
    let db;
    before(() => { db = makeDb(); });

    it('returns 500 for getBalances', () => {
        expect(db.getMaxMethodResults('getBalances')).to.equal(500);
    });

    it('returns 500 for getHolders', () => {
        expect(db.getMaxMethodResults('getHolders')).to.equal(500);
    });

    it('returns 100 for getActions (default)', () => {
        expect(db.getMaxMethodResults('getActions')).to.equal(100);
    });

    it('returns 100 for getTokens (default)', () => {
        expect(db.getMaxMethodResults('getTokens')).to.equal(100);
    });

    it('returns 100 for getSends (default)', () => {
        expect(db.getMaxMethodResults('getSends')).to.equal(100);
    });

    it('returns 100 for an unknown method string', () => {
        expect(db.getMaxMethodResults('nonExistentMethod')).to.equal(100);
    });

    it('returns 100 when method is undefined', () => {
        expect(db.getMaxMethodResults(undefined)).to.equal(100);
    });

    it('returns 100 when method is null', () => {
        expect(db.getMaxMethodResults(null)).to.equal(100);
    });

    it('returns 100 for getBlocks', () => {
        expect(db.getMaxMethodResults('getBlocks')).to.equal(100);
    });

    it('returns 100 for getMarket', () => {
        expect(db.getMaxMethodResults('getMarket')).to.equal(100);
    });
});

// ---------------------------------------------------------------------------
// getQueryWhereSql
// ---------------------------------------------------------------------------

describe('Database#getQueryWhereSql', () => {
    let db;
    before(() => { db = makeDb(); });

    // --- Default base sql ---------------------------------------------------

    it('default: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getActions', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('getIssues with no type: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    // --- Method-specific base overrides ------------------------------------

    it('getBalances: base is m.address_id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBalances', null));
        expect(sql).to.equal('m.address_id IS NOT NULL');
    });

    it('getHolders: base is m.address_id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHolders', null));
        expect(sql).to.equal('m.address_id IS NOT NULL');
    });

    it('getBlocks: base is b1.block_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlocks', null));
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('getBlock: base is b1.block_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlock', null));
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('getTransaction: base is m.tx_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTransaction', null));
        expect(sql).to.equal('m.tx_index IS NOT NULL');
    });

    it('getMarket: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarket', null));
        // getMarket always appends tick clause
        expect(sql).to.include('m.id IS NOT NULL');
    });

    it('getMarkets: base is m.id IS NOT NULL (no type)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarkets', null));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    // --- type='address' ----------------------------------------------------

    it('type=address on a standard method: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a2.address=?');
    });

    it('type=address on getMessages: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMessages', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getMints: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMints', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getOrders: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getOrders', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getSends: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getSends', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getSweeps: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getSweeps', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getDispensers: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    it('type=address on getDispenses: appends dual-address OR clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND (a2.address=? OR a3.address=?)');
    });

    // --- type='block' ------------------------------------------------------

    it('type=block on a standard method: appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'block'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('type=block on getBlocks: does NOT append block clause (getBlocks excluded)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlocks', 'block'));
        // getBlocks is in the exclusion list — only base sql returned
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    // --- type='source' / type='destination' --------------------------------

    it('type=source on a standard method: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'source'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a2.address=?');
    });

    it('type=destination on a standard method: appends AND a3.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'destination'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a3.address=?');
    });

    // --- type='token' ------------------------------------------------------

    it('type=token on a standard method: appends AND t3.tick=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick=?');
    });

    it('type=token on getFiles: appends AND m.type_id=1 AND t4.tick=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getFiles', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=1 AND t4.tick=?');
    });

    it('type=token on getTokens: appends AND t3.tick LIKE ?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTokens', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick LIKE ?');
    });

    it('type=subtoken on getTokens: appends AND t3.tick LIKE ?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTokens', 'subtoken'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND t3.tick LIKE ?');
    });

    // --- getMarket tick clause (always) ------------------------------------

    it('getMarket: appends tick OR-pair clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarket', null));
        expect(sql).to.equal('m.id IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    // --- getMarkets + type='token' -----------------------------------------

    it('getMarkets + type=token: appends AND (t1.tick=? OR t2.tick=?)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarkets', 'token'));
        expect(sql).to.equal('m.id IS NOT NULL AND (t1.tick=? OR t2.tick=?)');
    });

    // --- getMarketOrders / getMarketOrderbook / getMarketHistory -----------

    it('getMarketOrders: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrders', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    it('getMarketOrderbook: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrderbook', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    it('getMarketHistory: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketHistory', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    it('getMarketOrders + search3: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrders', null, { search3: 'addr1' }));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?)) AND a2.address=?');
    });

    it('getMarketHistory + search3: appends AND (a2.address=? OR a3.address=?)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketHistory', null, { search3: 'addr1' }));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?)) AND (a2.address=? OR a3.address=?)');
    });

    // --- getHistory special cases ------------------------------------------

    it('getHistory + type=address: appends m.type_id=2 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=2 AND m.id=?');
    });

    it('getHistory + type=token: appends m.type_id=1 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=1 AND m.id=?');
    });

    it('getHistory + type=block: appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'block'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('getHistory + no type: returns base m.action_index IS NOT NULL only', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });
});

// ---------------------------------------------------------------------------
// getQueryOffsetSql
// ---------------------------------------------------------------------------

describe('Database#getQueryOffsetSql', () => {
    let db;
    before(() => { db = makeDb(); });

    // --- No offset / no action / no start ----------------------------------

    it('returns empty string and empty args when offset is absent', async () => {
        const config = makeConfig({ data: { method: 'getActions', type: null } });
        const [sql, args] = await db.getQueryOffsetSql(config);
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when action is null', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', null, 100, 200));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when start is null', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', null, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty string when start is non-numeric', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 'abc', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    // --- Default field (m.action_index) — parameterized --------------------

    it('action=next with start only: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, null));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args).to.deep.equal([500]);
    });

    it('action=next with start+stop: two parameterized placeholders', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 100));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    it('action=prev with start only: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'prev', 100, null));
        expect(sql).to.equal(' AND m.action_index > ?');
        expect(args).to.deep.equal([100]);
    });

    it('action=prev with start+stop: two parameterized placeholders', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'prev', 100, 500));
        expect(sql).to.equal(' AND m.action_index > ? AND m.action_index < ?');
        expect(args).to.deep.equal([100, 500]);
    });

    it('action=last with start: parameterized placeholder', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'last', 300, null));
        expect(sql).to.equal(' AND m.action_index <= ?');
        expect(args).to.deep.equal([300]);
    });

    it('action=last with start+stop: parameterized (stop ignored)', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'last', 300, 100));
        expect(sql).to.equal(' AND m.action_index <= ?');
        expect(args).to.deep.equal([300]);
    });

    // --- Unknown action treated like next (else branch) --------------------

    it('unknown action with start+stop: falls through to next-style clause', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'first', 500, 100));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    // --- getBlocks uses b1.block_index -------------------------------------

    it('getBlocks action=next with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'next', 800, 600));
        expect(sql).to.equal(' AND b1.block_index < ?');
        expect(args).to.deep.equal([800]);
    });

    it('getBlocks action=prev with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'prev', 200, null));
        expect(sql).to.equal(' AND b1.block_index > ?');
        expect(args).to.deep.equal([200]);
    });

    it('getBlocks action=last with start: uses b1.block_index', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'last', 500, null));
        expect(sql).to.equal(' AND b1.block_index <= ?');
        expect(args).to.deep.equal([500]);
    });

    it('getBlocks: stop is always suppressed even when provided', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getBlocks', 'prev', 200, 100));
        expect(sql).to.equal(' AND b1.block_index > ?');
        expect(args).to.deep.equal([200]);
    });

    // --- getTokens uses m.id -----------------------------------------------

    it('getTokens action=next with start+stop: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'next', 50, 10));
        expect(sql).to.equal(' AND m.id < ? AND m.id > ?');
        expect(args).to.deep.equal([50, 10]);
    });

    it('getTokens action=prev with start: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'prev', 10, null));
        expect(sql).to.equal(' AND m.id > ?');
        expect(args).to.deep.equal([10]);
    });

    it('getTokens action=last with start: uses m.id', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getTokens', 'last', 75, null));
        expect(sql).to.equal(' AND m.id <= ?');
        expect(args).to.deep.equal([75]);
    });

    // --- Numeric coercion --------------------------------------------------

    it('start/stop are parsed as integers (string numbers accepted)', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '500', '100'));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });
});
