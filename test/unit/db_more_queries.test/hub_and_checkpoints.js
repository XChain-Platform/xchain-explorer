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
 * Additional unit tests for uncovered methods in src/db/index.js
 *
 * Covers (SQL-builder methods, return [query, args, count]):
 *   - getCoinpays, getCoinpayExpires, getCoinpayObligations
 *   - getMarkets, getMarket, getMarketOrders, getMarketHistory, getOrderbook
 *   - getActions, getAction, getBlocks
 *   - getSearch
 *   - getPublicKey, getTransactionData
 *   - getContracts, getContract, getContractState, getContractBalance
 *   - getExecutions, getExecution, getDeposits, getWithdrawals
 *   - getStakes, getValidators, getPrices, getPriceSnapshots, getDelegations
 *   - getValidatorRewards, getContractStakes, getContractUnstakes, getSlashEvents
 *   - getHistory
 *
 * Covers (helper/detail methods, stub doQuery):
 *   - getMaxBlockIndex, getMaxBlockTime, getMaxActionIndex
 *   - getGatedFileRaw, getBlocksSince, getActionsSince
 *   - getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo
 *   - getCoinpayObligation, getOrderMatchSettlement
 *   - getPublicKey, getTransactionData
 *   - getActionFeeData
 *   - getHistoryData (basic)
 *   - getActionSummaryData (basic pass-through)
 *
 * Covers (LRU cache helpers):
 *   - cacheGet, cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

const {
    configInfo,
    sinon,
    expect,
    makeConfig,
    mockResults,
    makeDb,
    cfg,
    makeActionConfig,
    baseRow,
    stubForType
} = require('./helpers.js');


// Hub operational-state pages (p2p_peers/consensus_state/configs/telemetry_pings) are
// served ONLY from the mandatory co-located hub DB, same as the governance and
// cross-chain mirrors. These structural tests configure that hub DB so the query builds;
// the "no hub DB -> fail loud" behavior gets one shared assertion below.
const HUB_OPS = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

describe('Database#getPeers', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getPeers(makeActionConfig('getPeers', 'validator'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "p2p_peers" with addr/validator_id/is_seed, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query, , count] = await db.getPeers(makeActionConfig('getPeers', 'validator'));
        expect(query).to.include('`XChain_Hub`.p2p_peers m');
        expect(query).to.include('m.addr');
        expect(query).to.include('m.validator_id');
        expect(query).to.include('m.is_seed');
        expect(query).to.include('ORDER BY m.id');
        expect(count).to.include('`XChain_Hub`.p2p_peers m');
    });

    it('no checkpoint hub DB -> fails loud (no local-mirror fallback)', async () => {
        const db = makeDb();
        let err = null;
        try { await db.getPeers(makeActionConfig('getPeers')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});

describe('Database#getConsensusState', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getConsensusState(makeActionConfig('getConsensusState', 'key'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "consensus_state" with key_name/value, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getConsensusState(makeActionConfig('getConsensusState', 'key'));
        expect(query).to.include('`XChain_Hub`.consensus_state m');
        expect(query).to.include('m.key_name');
        expect(query).to.include('m.value');
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getConfigs', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getConfigs(makeActionConfig('getConfigs', 'coin'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "configs" with coin/network/module/param, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getConfigs(makeActionConfig('getConfigs', 'module'));
        expect(query).to.include('`XChain_Hub`.configs m');
        expect(query).to.include('m.coin');
        expect(query).to.include('m.network');
        expect(query).to.include('m.module');
        expect(query).to.include('m.param_name');
        expect(query).to.include('m.param_value');
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getTelemetryPings', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const result = await db.getTelemetryPings(makeActionConfig('getTelemetryPings', 'event'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads the hub-qualified "telemetry_pings" with the software fingerprint, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getTelemetryPings(makeActionConfig('getTelemetryPings', 'event'));
        expect(query).to.include('`XChain_Hub`.telemetry_pings m');
        expect(query).to.include('m.install_id');
        expect(query).to.include('m.node_version');
        expect(query).to.include('m.os_platform');
        expect(query).to.include('m.event');
        expect(query).to.include('ORDER BY m.id');
    });

    it('never selects the ip_hash column (privacy: the keyed IP hash stays hub-internal)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB_OPS };
        const [query] = await db.getTelemetryPings(makeActionConfig('getTelemetryPings'));
        expect(query).to.not.include('ip_hash');
    });
});

describe('Database.getCheckpointAtOrAbove ordering (SPV latest-default)', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        sinon.stub(db, 'checkpointSource').returns({ table: 'state_checkpoints', filter: '', filterParams: [] });
    });
    afterEach(() => sinon.restore());

    it('orders DESC (latest checkpoint) when height is null', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (config, q) => { captured = q; return []; });
        await db.getCheckpointAtOrAbove(cfg(), null);
        expect(captured).to.match(/ORDER BY sc\.block_index DESC LIMIT 1/);
        expect(captured).to.not.match(/block_index >= \?/);
    });

    it('orders ASC (nearest at or above) when a height is given', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (config, q) => { captured = q; return []; });
        await db.getCheckpointAtOrAbove(cfg(), 500);
        expect(captured).to.match(/ORDER BY sc\.block_index ASC LIMIT 1/);
        expect(captured).to.match(/block_index >= \?/);
    });
});

// The checkpoint routes are the ONLY REST surface that shapes BigInt indices by
// hand (the catch-all path goes through utility.jsonStringify, which stringifies
// BigInt; so does ws/serialize.js). They emitted JSON numbers, so the same field
// name was a string on /block and a number on /checkpoints, breaking strict
// equality against a WS NEW_BLOCK index. Pin the string wire type here so the
// hand-shaped path cannot drift back.
describe('Database._normalizeCheckpointRows emits BigInt indices as strings @regression', () => {
    const db = makeDb();

    it('coerces block_index/checkpoint_seq/snapshot_block to decimal strings', () => {
        const [row] = db.normalizeCheckpointRows([{
            chain: 'BTC', network: 'mainnet', block_hash: 'ff'.repeat(32),
            block_index: 100n, checkpoint_seq: 7n, snapshot_block: 2000000n
        }]);
        expect(row.block_index).to.equal('100');
        expect(row.checkpoint_seq).to.equal('7');
        expect(row.snapshot_block).to.equal('2000000');
    });

    it('preserves precision past 2^53 (the reason Number() was wrong)', () => {
        const [row] = db.normalizeCheckpointRows([{ block_index: 9007199254740993n, checkpoint_seq: 1n, snapshot_block: 1n }]);
        expect(row.block_index).to.equal('9007199254740993');
    });

    it('leaves non-index fields untouched (validator_signatures excepted: parsed to array)', () => {
        const [row] = db.normalizeCheckpointRows([{
            block_index: 1n, checkpoint_seq: 1n, snapshot_block: 1n,
            state_root: 'ab'.repeat(32), validator_signatures: '[]'
        }]);
        expect(row.state_root).to.equal('ab'.repeat(32));
        expect(row.validator_signatures).to.deep.equal([]);
    });

    it('validator_signatures: one wire type (array) across the checkpoint REST family', () => {
        const sigs = [{ pubkey: 'aa', sig: 'bb' }];
        const mk = (v) => db.normalizeCheckpointRows([{
            block_index: 1n, checkpoint_seq: 1n, snapshot_block: 1n, validator_signatures: v
        }])[0].validator_signatures;
        expect(mk(JSON.stringify(sigs))).to.deep.equal(sigs);   // DB JSON string -> array
        expect(mk(sigs)).to.deep.equal(sigs);                   // already-parsed passthrough
        expect(mk('not json')).to.deep.equal([]);               // malformed degrades to []
        expect(mk(null)).to.deep.equal([]);                     // absent degrades to []
    });

    it('empty/null rows → empty array', () => {
        expect(db.normalizeCheckpointRows(null)).to.deep.equal([]);
        expect(db.normalizeCheckpointRows([])).to.deep.equal([]);
    });
});
