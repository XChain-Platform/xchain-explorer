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

// Create a Database instance without a real MariaDB connection.
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

describe('Database#getQueryWhereSql', () => {
    let db;
    before(() => { db = makeDb(); });

    it('default: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getActions', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('getIssues with no type: returns m.action_index IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', null));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

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

    it('type=block on a standard method: appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'block'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('type=block on getBlocks: does NOT append block clause (getBlocks excluded)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBlocks', 'block'));
        // getBlocks is in the exclusion list; only base sql returned
        expect(sql).to.equal('b1.block_index IS NOT NULL');
    });

    it('type=source on a standard method: appends AND a2.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'source'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a2.address=?');
    });

    it('type=destination on a standard method: appends AND a3.address=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'destination'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND a3.address=?');
    });

    it('type=oracle on getDispensers: filters on the dispenser oracle_address_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'oracle'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)');
    });

    // The a5 oracle-address join exists only on the getDispensers row query, so
    // the lane must not leak onto sibling methods whose SQL has no such column.
    it('type=oracle on getDispenses: appends nothing (lane is getDispensers-only)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'oracle'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

    it('type=dispenser on getDispenses: filters on the dispense dispenser_action_index', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispenses', 'dispenser'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.dispenser_action_index=?');
    });

    // Only the dispenses table carries dispenser_action_index; the lane must not
    // leak onto sibling methods whose SQL has no such column.
    it('type=dispenser on getDispensers: appends nothing (lane is getDispenses-only)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getDispensers', 'dispenser'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });

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

    it('getMarket: appends tick OR-pair clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarket', null));
        expect(sql).to.equal('m.id IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    it('getMarkets + type=token: appends AND (t1.tick=? OR t2.tick=?)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarkets', 'token'));
        expect(sql).to.equal('m.id IS NOT NULL AND (t1.tick=? OR t2.tick=?)');
    });

    it('getMarketOrders: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getMarketOrders', null));
        expect(sql).to.equal('m.action_index IS NOT NULL AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))');
    });

    it('getOrderbook: appends tick clause, no search3', async () => {
        const sql = await db.getQueryWhereSql(cfg('getOrderbook', null));
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

    it('getHistory + type=address: appends m.type_id=2 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'address'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=2 AND m.id=?');
    });

    it('getHistory + type=token: appends m.type_id=1 AND m.id=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'token'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.type_id=1 AND m.id=?');
    });

    // The block and untyped feeds anchor on a1, not m: getHistoryData drives them
    // off `actions` directly, because mappings_actions carries no row for an action
    // that moved no ledger entry (see db.history-unmapped-actions.test.js).
    it('getHistory + type=block: anchors on a1 and appends AND b1.block_index=?', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'block'));
        expect(sql).to.equal('a1.action_index IS NOT NULL AND b1.block_index=?');
    });

    it('getHistory + no type: returns base a1.action_index IS NOT NULL only', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', null));
        expect(sql).to.equal('a1.action_index IS NOT NULL');
    });

    it('getHistory + type=recent: anchors on a1 (the homepage All Activity feed)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getHistory', 'recent'));
        expect(sql).to.equal('a1.action_index IS NOT NULL');
    });
});

describe('Database#getQueryOffsetSql', () => {
    let db;
    before(() => { db = makeDb(); });

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

    it('unknown action with start+stop: falls through to next-style clause', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'first', 500, 100));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

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

    it('start/stop are parsed as integers (string numbers accepted)', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '500', '100'));
        expect(sql).to.equal(' AND m.action_index < ? AND m.action_index > ?');
        expect(args).to.deep.equal([500, 100]);
    });

    it('returns empty when offset exists but start is empty string', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', '', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty when offset exists but start is undefined', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', undefined, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('returns empty when action is empty string', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', '', 100, null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });

    it('action=next with start and stop=0: stop is false after sanitizeInt', async () => {
        // stop=0 comes back 0 from sanitizeInt, and 0 is falsy, so `if(stop)` treats it as absent.
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 500, 0));
        expect(sql).to.equal(' AND m.action_index < ?');
        expect(args).to.deep.equal([500]);
    });

    it('sanitizeInt default false: non-numeric start falls back to false', async () => {
        const [sql, args] = await db.getQueryOffsetSql(cfgOffset('getActions', 'next', 'abc', null));
        expect(sql).to.equal('');
        expect(args).to.deep.equal([]);
    });
});

describe('Database#getQueryWhereSql cross-chain + contract-delegation clauses', () => {
    let db;
    before(() => { db = makeDb(); });

    it('getCrossChainMatches with no type: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainMatches', null));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getCrossChainMatches type=match filters m.match_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainMatches', 'match'));
        expect(sql).to.include('m.match_id=?');
    });

    it('getCrossChainMatches type=block filters m.snapshot_block (no b1 join)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainMatches', 'block'));
        expect(sql).to.include('m.snapshot_block=?');
        expect(sql).to.not.include('b1.block_index');
    });

    it('getCrossChainMatches type=status filters m.status', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainMatches', 'status'));
        expect(sql).to.include('m.status=?');
    });

    it('getCrossChainSettlements type=block filters its own m.block_index', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainSettlements', 'block'));
        expect(sql).to.include('m.block_index=?');
        expect(sql).to.not.include('b1.block_index');
    });

    it('getCrossChainSettlements type=match filters m.match_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getCrossChainSettlements', 'match'));
        expect(sql).to.include('m.match_id=?');
    });

    it('getContractDelegations type=contract filters m.target_contract_index', async () => {
        const sql = await db.getQueryWhereSql(cfg('getContractDelegations', 'contract'));
        expect(sql).to.include('m.target_contract_index=?');
    });

    // Hub operational tables (p2p_peers/consensus_state/configs/telemetry_pings): id-keyed,
    // base is m.id IS NOT NULL, each with its own column filters.
    it('getPeers with no type: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getPeers', null));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getPeers type=validator filters m.validator_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getPeers', 'validator'));
        expect(sql).to.include('m.validator_id=?');
    });

    it('getConsensusState with no type: base is m.id IS NOT NULL', async () => {
        const sql = await db.getQueryWhereSql(cfg('getConsensusState', null));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getConsensusState type=key filters m.key_name', async () => {
        const sql = await db.getQueryWhereSql(cfg('getConsensusState', 'key'));
        expect(sql).to.include('m.key_name=?');
    });

    it('getConfigs type=coin filters m.coin', async () => {
        const sql = await db.getQueryWhereSql(cfg('getConfigs', 'coin'));
        expect(sql).to.include('m.coin=?');
    });

    it('getConfigs type=module filters m.module', async () => {
        const sql = await db.getQueryWhereSql(cfg('getConfigs', 'module'));
        expect(sql).to.include('m.module=?');
    });

    it('getTelemetryPings type=event filters m.event', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTelemetryPings', 'event'));
        expect(sql).to.include('m.event=?');
    });

    it('getTelemetryPings type=install filters m.install_id', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTelemetryPings', 'install'));
        expect(sql).to.include('m.install_id=?');
    });

    it('getTelemetryPings type=country filters m.country', async () => {
        const sql = await db.getQueryWhereSql(cfg('getTelemetryPings', 'country'));
        expect(sql).to.include('m.country=?');
    });

    it('getBetFeeds type=status filters the STORED feed status, not a clock recomputation', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBetFeeds', 'status'));
        expect(sql).to.include('fs.status=?');
        // A derived close would have to compare deadline against a clock; if this
        // ever starts referencing m.deadline the list has stopped agreeing with
        // the stored latch that E11 (backdating) depends on.
        expect(sql).to.not.include('m.deadline');
    });

    it('getBetFeeds type=token filters the wager tick through index_tickers', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBetFeeds', 'token'));
        expect(sql).to.include('pt.tick=?');
    });

    it('getBetFeeds type=source and type=address both filter the oracle address', async () => {
        expect(await db.getQueryWhereSql(cfg('getBetFeeds', 'source'))).to.include('a2.address=?');
        expect(await db.getQueryWhereSql(cfg('getBetFeeds', 'address'))).to.include('a2.address=?');
    });

    it('getBetFeeds type=block filters the creating block', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBetFeeds', 'block'));
        expect(sql).to.include('b1.block_index=?');
    });

    it('getBetFeed keys on the creating action_index (the feed id)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBetFeed', null));
        expect(sql).to.include('m.action_index=?');
    });

    it('getBets type=feed scopes to one market', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBets', 'feed'));
        expect(sql).to.include('m.feed_action_index=?');
    });

    it('getBets type=address filters the bettor (the tx source)', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBets', 'address'));
        expect(sql).to.include('a2.address=?');
    });

    it('getBets type=status filters the stored bet status', async () => {
        const sql = await db.getQueryWhereSql(cfg('getBets', 'status'));
        expect(sql).to.include('bs.status=?');
    });

    it('getBets type=token and type=block filter tick and block', async () => {
        expect(await db.getQueryWhereSql(cfg('getBets', 'token'))).to.include('pt.tick=?');
        expect(await db.getQueryWhereSql(cfg('getBets', 'block'))).to.include('b1.block_index=?');
    });
});

describe('getQuery() API OFFSET cap', function () {
    // A synchronous stub query-builder so getQuery does not hit the DB. getQuery
    // sets config.data.sql.apiOffset BEFORE invoking this[data.method].
    function makeDbWithProbe() {
        const db = makeDb();
        db.probeMethod = () => ['SELECT 1', [], 0];
        return db;
    }

    it('caps apiOffset at 100000 for a huge page (query-complexity DoS guard)', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '999999', limit: '100' } });
        await db.getQuery(config);
        expect(config.data.sql.apiOffset).to.equal(100000);
    });

    it('leaves a normal page offset uncapped', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '3', limit: '20' } });
        await db.getQuery(config);
        expect(config.data.sql.apiOffset).to.equal(40); // (3 - 1) * 20
    });

    it('never produces a negative or NaN offset for a bogus page', async function () {
        const db = makeDbWithProbe();
        const config = cfg('probeMethod', 'api', { query: { page: '-5', limit: '20' } });
        await db.getQuery(config);
        // page clamps to >=1, so offset is 0
        expect(config.data.sql.apiOffset).to.equal(0);
    });
});

describe('getQuery() explorer start guard', function () {
    // The explorer branch is selected by the TOP-LEVEL config.type, not data.type, so
    // these build the config directly rather than through cfg(). getBalances is one of
    // the fetch-and-slice methods whose sql.limit is start+length, and getQueryOffsets
    // returns early for it, so no DB is touched.
    function explorerConfig(query) {
        return makeConfig({ type: 'explorer', data: { method: 'getBalances', type: null, query } });
    }
    function makeDbWithProbe() {
        const db = makeDb();
        db.getBalances = () => ['SELECT 1', [], 0];
        return db;
    }

    // sql.limit is string-concatenated into `LIMIT ` + sql.limit at ~40 sites, so a
    // NaN here is `LIMIT NaN`: a rejected query, answered 5xx on an unauthenticated
    // read route. Pre-guard these two cases produced the string "NaN".
    ['abc', '7junk', '1e999'].forEach((bad) => {
        it(`falls back to start=0 for a non-finite ?start=${JSON.stringify(bad)}`, async function () {
            const db = makeDbWithProbe();
            const config = explorerConfig({ start: bad, length: '10' });
            await db.getQuery(config);
            expect(Number.isFinite(Number(config.data.sql.limit))).to.equal(true);
            expect(Number(config.data.sql.limit)).to.equal(10);
        });
    });

    it('falls back to start=0 for a repeated (array-valued) ?start=', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: ['1', '2'], length: '10' });
        await db.getQuery(config);
        expect(Number.isFinite(Number(config.data.sql.limit))).to.equal(true);
        expect(Number(config.data.sql.limit)).to.equal(10);
    });

    it('leaves normal paging alone', async function () {
        const db = makeDbWithProbe();
        const config = explorerConfig({ start: '50', length: '10' });
        await db.getQuery(config);
        expect(Number(config.data.sql.limit)).to.equal(60);
    });
});
