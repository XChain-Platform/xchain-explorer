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

describe('Database#getPrices', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getPrices(makeActionConfig('getPrices'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "prices" table with coin/fiat/tick joins', async () => {
        const db = makeDb();
        const [query] = await db.getPrices(makeActionConfig('getPrices'));
        expect(query).to.include('prices m');
        expect(query).to.include('index_coins');
        expect(query).to.include('index_fiats');
        expect(query).to.include('m.round_number');
    });

    // a validator batch stores NULL in pair_count, so the only server-side
    // statement of how wide a round is comes from counting the first round's pairs.
    // Counted in SQL rather than shipped as rounds_json, which is megabytes a page.
    it('counts the first batch round\'s pairs so the list row can state a width', async () => {
        const db = makeDb();
        const [query] = await db.getPrices(makeActionConfig('getPrices'));
        expect(query).to.match(/JSON_LENGTH\(m\.rounds_json,\s*'\$\[0\]\.pairs'\)\s+as\s+batch_pair_count/);
    });

    it('carries the batch window columns the list row describes a batch with', async () => {
        const db = makeDb();
        const [query] = await db.getPrices(makeActionConfig('getPrices'));
        for(const col of ['m.batch_first_round', 'm.batch_last_round', 'm.round_count', 'm.pair_count'])
            expect(query).to.include(col);
    });

    // rounds_json itself is the megabyte column; only its counted width may ship.
    it('never selects rounds_json into the list feed', async () => {
        const db = makeDb();
        const [query, , count] = await db.getPrices(makeActionConfig('getPrices'));
        expect(query).to.not.match(/^\s*m\.rounds_json,?\s*$/m);
        expect(count).to.not.include('rounds_json');
    });
});

describe('Database#getPriceSnapshots', () => {
    // price_snapshots is hub-mirrored: xchain-sync never replicates it in any
    // channel, so it is served only from the mandatory co-located hub DB. These
    // structural tests configure that hub DB so the query builds; the "no hub DB ->
    // fail loud" behavior has its own test below.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "price_snapshots" table', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(query).to.include('price_snapshots m');
        expect(query).to.include('m.coin_pair');
        expect(query).to.include('m.price');
    });

    it('checkpoint hub DB configured -> database-qualifies price_snapshots (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots'));
        expect(query).to.include('`XChain_Hub`.price_snapshots m');
        expect(count).to.include('`XChain_Hub`.price_snapshots m');
    });

    it('no checkpoint hub DB -> fails loud (no silent empty local mirror)', async () => {
        const db = makeDb();
        // checkpointDb is empty by default. price_snapshots only ever arrives via
        // hub_db_sync, so a thin replica's local copy is an empty table the live
        // stream never fills: throw rather than serve it as a real result set.
        let err = null;
        try { await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.include('price_snapshots');
    });

    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getPriceSnapshots(makeActionConfig('getPriceSnapshots')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getDelegations', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "delegations" table', async () => {
        const db = makeDb();
        const [query] = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(query).to.include('delegations m');
    });

    it('query exposes activation_block / deactivation_block (parity with getStakes)', async () => {
        const db = makeDb();
        const [query] = await db.getDelegations(makeActionConfig('getDelegations'));
        expect(query).to.include('m.activation_block');
        expect(query).to.include('m.deactivation_block');
    });
});

describe('Database#getValidatorRewards', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getValidatorRewards(makeActionConfig('getValidatorRewards'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "validator_rewards" table', async () => {
        const db = makeDb();
        const [query] = await db.getValidatorRewards(makeActionConfig('getValidatorRewards'));
        expect(query).to.include('validator_rewards m');
        expect(query).to.include('m.reward_type');
    });
});

describe('Database#getContractStakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractStakes(makeActionConfig('getContractStakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_stakes" table', async () => {
        const db = makeDb();
        const [query] = await db.getContractStakes(makeActionConfig('getContractStakes'));
        expect(query).to.include('contract_stakes m');
        expect(query).to.include('m.target_contract_index');
    });
});

describe('Database#getContractUnstakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getContractUnstakes(makeActionConfig('getContractUnstakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "contract_unstakes" table', async () => {
        const db = makeDb();
        const [query] = await db.getContractUnstakes(makeActionConfig('getContractUnstakes'));
        expect(query).to.include('contract_unstakes m');
        expect(query).to.include('m.cooldown_end_block');
    });
});

describe('Database#getSlashEvents', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "slash_events" table (no action_index)', async () => {
        const db = makeDb();
        const [query] = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(query).to.include('slash_events m');
        expect(query).to.include('m.execution_index');
        expect(query).to.include('m.target_contract_index');
    });

    it('ORDER BY uses m.id (not m.action_index)', async () => {
        const db = makeDb();
        const [query] = await db.getSlashEvents(makeActionConfig('getSlashEvents'));
        expect(query).to.include('ORDER BY m.id');
    });
});

describe('Database#getDecoderTip', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when decoderDb has no entry for coin', async () => {
        db.decoderDb = {};
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns null for unsafe DB identifier', async () => {
        db.decoderDb = { BTC: 'bad name; DROP TABLE' };
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns the max block_index number from the decoder DB', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').resolves([{ max_index: 850000 }]);
        expect(await db.getDecoderTip(cfg())).to.equal(850000);
    });

    it('returns null when doQuery throws (no cross-DB grant)', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').rejects(new Error('no grant'));
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });

    it('returns null when max_index is null', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getDecoderTip(cfg())).to.be.null;
    });
});

let db;

async function getContractStateBaseQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContractState', type: null } }));
    expect(sql).to.include('cs.id IS NOT NULL');
}

async function getSlashEventsBaseQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: null } }));
    expect(sql).to.equal('m.id IS NOT NULL');
}

async function getPriceSnapshotsBaseQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: null } }));
    expect(sql).to.equal('m.id IS NOT NULL');
}

async function getSlashEventsBlockQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'block' } }));
    expect(sql).to.include('m.block_index=?');
}

async function getCoinpayObligationsBlockQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCoinpayObligations', type: 'block' } }));
    expect(sql).to.include('m.block_index=?');
    expect(sql).to.not.include('b1.block_index');
}

async function getSlashEventsContractQuery() {
    const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'contract' } }));
    expect(sql).to.include('m.target_contract_index=?');
}

// Branches the query builder tests in db_query_builder.test.js do not reach.
describe('Database#getQueryWhereSql: additional branches', () => {
    before(() => { db = makeDb(); });

    it('getContractState: base is cs.id IS NOT NULL', getContractStateBaseQuery);

    it('getSlashEvents: base is m.id IS NOT NULL', getSlashEventsBaseQuery);

    it('getPriceSnapshots: base is m.id IS NOT NULL', getPriceSnapshotsBaseQuery);

    it('getSlashEvents + type=block: appends AND m.block_index=?', getSlashEventsBlockQuery);

    it('getCoinpayObligations + type=block: filters on m.block_index (no blocks join exists; b1 would 500)', getCoinpayObligationsBlockQuery);

    it('getSlashEvents + type=contract: appends AND m.target_contract_index=?', getSlashEventsContractQuery);

    it('getSlashEvents + type=address: appends signing_pubkey_id subquery', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getSlashEvents', type: 'address' } }));
        expect(sql).to.include('signing_pubkey_id');
        expect(sql).to.include('contract_stakes');
    });

    it('getPriceSnapshots + type=pair: appends AND m.coin_pair=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'pair' } }));
        expect(sql).to.include('m.coin_pair=?');
    });

    it('getPriceSnapshots + type=round: appends AND m.round_number=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'round' } }));
        expect(sql).to.include('m.round_number=?');
    });

    it('getPriceSnapshots + type=status: appends AND m.status=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getPriceSnapshots', type: 'status' } }));
        expect(sql).to.include('m.status=?');
    });

    it('type=contract on getContracts: appends AND m.contract_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'contract' } }));
        expect(sql).to.include('m.contract_index=?');
    });

    it('type=contract on getContract: appends AND m.action_index=?', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContract', type: 'contract' } }));
        expect(sql).to.include('m.action_index=?');
    });

    it('type=contract on getContractState: no extra clause appended', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContractState', type: 'contract' } }));
        // contract_index filter is applied inside the subquery; no outer clause
        expect(sql).to.equal('cs.id IS NOT NULL');
    });

    it('type=address on getCoinpayObligations: appends AND (a1.address=? OR a2.address=?)', async () => {
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCoinpayObligations', type: 'address' } }));
        expect(sql).to.include('a1.address=?');
        expect(sql).to.include('a2.address=?');
    });
});

// Slash events are keyed by row id rather than action index, so they page on m.id.
