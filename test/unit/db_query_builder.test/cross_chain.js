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
 * Unit tests for SQL generation functions in src/db/index.js
 *
 * Tests:
 *   - getMaxMethodResults(method)
 *   - getQueryWhereSql(config)
 *   - getQueryOffsetSql(config)
 */

'use strict';

const { expect, cfg } = require('../db_query_builder.test.js');

const { makeQueryBuilderDb } = require('./helpers.js');

let db;

function registerCrossChainCases1() {

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

}

function registerCrossChainCases2() {

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

}

function registerCrossChainCases3() {

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

}

describe('Database#getQueryWhereSql cross-chain + contract-delegation clauses', () => {
    before(() => { db = makeQueryBuilderDb(); });
    registerCrossChainCases1();
    registerCrossChainCases2();
    registerCrossChainCases3();
});
