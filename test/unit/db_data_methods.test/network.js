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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, mockResults, makeDb, cfg } = require('./helpers.js');

describe('Database#getMempool', () => {
    let db;
    before(() => { db = makeDb(); });

    it('returns an empty direct-data result when no decoder DB is mapped', async () => {
        const config = cfg();
        const [data, args, total] = await db.getMempool(config);
        expect(data).to.deep.equal([]);
        expect(args).to.equal(null);
        expect(total).to.equal(0);
    });

    it('does not throw when called', async () => {
        const config = cfg();
        let threw = false;
        try {
            await db.getMempool(config);
        } catch(e) {
            threw = true;
        }
        expect(threw).to.be.false;
    });
});

// Helper to set up a pool config so the information_schema branch runs.
function setupPool(dbObj, coin, dbName) {
    dbObj.pools = dbObj.pools || {};
    dbObj.pools[coin] = { config: { database: dbName }, pool: {} };
}

// Build a realistic information_schema rows response for all non-fnv tables.
function makeInfoSchemaRows(dbObj, count) {
    const tables = [...dbObj.actionTables, 'tokens'].filter(t => t !== 'full_node_verifications');
    return tables.map(t => ({ TABLE_NAME: t, TABLE_ROWS: count }));
}

// Shared stub factory: routes queries by content so order doesn't matter.
// - information_schema query -> TABLE_NAME/TABLE_ROWS rows
// - per-table COUNT(*) UNION (getActionTotals exact counts) -> [{ t, c }] rows
// - full_node_verifications COUNT(DISTINCT) -> [{ count: N }]
// - anything else (getMaxBlockIndex/getMaxBlockTime/etc.) -> [{ count: N }] or matching shape
function makeNetworkStub(dbObj, countVal) {
    const infoRows = makeInfoSchemaRows(dbObj, countVal);
    const unionRows = [...dbObj.actionTables, 'tokens']
        .filter(t => t !== 'full_node_verifications')
        .map(t => ({ t: t, c: countVal }));
    return (config, query) => {
        if(typeof query === 'string' && query.includes('information_schema'))
            return Promise.resolve(infoRows);
        if(typeof query === 'string' && query.includes("AS t, COUNT(*) AS c"))
            return Promise.resolve(unionRows);
        return Promise.resolve([{ count: countVal, max_index: countVal, block_time: countVal }]);
    };
}

describe('Database#getNetwork', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns object with totals, network, fee, coin, xchain, finality keys', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 5));

        const config = cfg();
        const [data] = await db.getNetwork(config);
        expect(data).to.have.keys(['totals', 'network', 'fee', 'coin', 'xchain', 'finality']);
    });

    // Finality is sourced from the vendored coin registry, not a hand-copied
    // literal map, so it stays in lockstep with the coin bundle's confirmations.
    it('sources finality from the coin registry (per-coin confirmation defaults)', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 5));

        const [data] = await db.getNetwork(cfg());
        const expected = require('../../../src/coins').resolveConfirmations({}, 'mainnet');
        expect(data.finality).to.deep.equal(expected);
        // Sanity: registry carries the canonical per-coin defaults.
        expect(data.finality.BTC).to.equal(6);
        expect(data.finality.LTC).to.equal(12);
        expect(data.finality.DOGE).to.equal(60);
    });

    it('populates totals for every actionTable plus tokens', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 3));

        const config  = cfg();
        const [data]  = await db.getNetwork(config);
        const expected = [...db.actionTables, 'tokens'];
        for(const table of expected){
            expect(data.totals).to.have.property(table);
        }
    });

    it('sets totals to the count values returned by doQuery', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 7));

        const config = cfg();
        const [data] = await db.getNetwork(config);
        for(const key in data.totals){
            expect(data.totals[key]).to.equal(7);
        }
    });
});

describe('Database#getNetwork', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('skips a table count when doQuery returns false for it', async () => {
        // Without a pool config, dbName is null so information_schema is skipped.
        // The full_node_verifications exact count also returns false, so totals stays empty.
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg();
        const [data] = await db.getNetwork(config);
        // No totals should be set when every doQuery call fails
        expect(Object.keys(data.totals)).to.have.length(0);
    });

    it('reports the real indexer tip + last-block time as network.block/time', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 1));
        sinon.stub(db, 'getMaxBlockIndex').resolves(800000);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);

        const [data] = await db.getNetwork(cfg());
        expect(data.network).to.have.keys(['block', 'time', 'unconfirmed', 'unconfirmed_node']);
        expect(data.network.block).to.equal(800000);
        expect(data.network.time).to.equal(1700000000);
        // Mempool isn't indexed yet, so unconfirmed is 0 rather than a fake value.
        expect(data.network.unconfirmed).to.equal(0);
        // No decoder API endpoint resolves here, so the node's total mempool
        // size is unknowable and must publish as null, never a fake 0.
        expect(data.network.unconfirmed_node).to.equal(null);
    });

    it('resolves coin name + symbol from the per-coin chain config', async () => {
        setupPool(db, 'BTC', 'XChain_BTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 1));
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        sinon.stub(db, 'getMaxBlockTime').resolves(0);

        const [data] = await db.getNetwork(cfg());            // coin: 'BTC'
        expect(data.coin.name).to.equal('Bitcoin');
        expect(data.coin.symbol).to.equal('BTC');
    });

    it('does not hardcode Bitcoin: a coin absent from config falls back to its own code', async () => {
        setupPool(db, 'LTC', 'XChain_LTC');
        sinon.stub(db, 'doQuery').callsFake(makeNetworkStub(db, 1));
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        sinon.stub(db, 'getMaxBlockTime').resolves(0);

        const [data] = await db.getNetwork(cfg({ coin: 'LTC' }));
        expect(data.coin.name).to.not.equal('Bitcoin');
        expect(data.coin.symbol).to.equal('LTC');
    });
});

let db;

describe('Database#getDecoderMempoolCount', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns 0 when no decoder DB is mapped for the coin', async () => {
        db.decoderDb = {};
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(0);
        expect(q.called).to.be.false;
    });

    it('returns 0 (and never queries) for an unsafe decoder DB identifier', async () => {
        db.decoderDb = { BTC: 'bad name; DROP TABLE' };
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(0);
        expect(q.called).to.be.false;
    });

    it('counts mempool_transactions in the decoder DB', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        const q = sinon.stub(db, 'doQuery').resolves([{ count: 42 }]);
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(42);
        expect(q.firstCall.args[1]).to.contain('mempool_transactions');
    });

    it('returns 0 when the query throws (e.g. no cross-DB grant)', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        sinon.stub(db, 'doQuery').rejects(new Error('no grant'));
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(0);
    });

    it('caches the count per coin for the TTL: second call does not re-query', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        const q = sinon.stub(db, 'doQuery').resolves([{ count: 7 }]);
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(7);
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(7);
        expect(q.callCount).to.equal(1);
    });

    it('re-queries once the TTL expires', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        process.env.MEMPOOL_COUNT_CACHE_MS = '1';
        try {
            const q = sinon.stub(db, 'doQuery');
            q.onFirstCall().resolves([{ count: 7 }]);
            q.onSecondCall().resolves([{ count: 9 }]);
            expect(await db.getDecoderMempoolCount(cfg())).to.equal(7);
            // Expiry is a stored timestamp: rewind the entry an hour instead of
            // sleeping the TTL out, so the staleness never rides the wall clock.
            expect(db._mempoolCountCache.BTC.t, 'the count should be cached').to.be.a('number');
            db._mempoolCountCache.BTC.t -= 60 * 60 * 1000;
            expect(await db.getDecoderMempoolCount(cfg())).to.equal(9);
            expect(q.callCount).to.equal(2);
        } finally {
            delete process.env.MEMPOOL_COUNT_CACHE_MS;
        }
    });
});

describe('Database#getDecoderMempoolCount', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('does not share a cached count across coins', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Decoder', LTC: 'XChain_LTC_Decoder' };
        const q = sinon.stub(db, 'doQuery');
        q.onFirstCall().resolves([{ count: 3 }]);
        q.onSecondCall().resolves([{ count: 8 }]);
        expect(await db.getDecoderMempoolCount(cfg())).to.equal(3);
        expect(await db.getDecoderMempoolCount(cfg({ coin: 'LTC' }))).to.equal(8);
        expect(q.callCount).to.equal(2);
    });

    it('serves the last good count when a refresh query throws', async () => {
        db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
        process.env.MEMPOOL_COUNT_CACHE_MS = '1';
        try {
            const q = sinon.stub(db, 'doQuery');
            q.onFirstCall().resolves([{ count: 11 }]);
            q.onSecondCall().rejects(new Error('no grant'));
            expect(await db.getDecoderMempoolCount(cfg())).to.equal(11);
            // Same as above: age the cached entry rather than sleeping, so the
            // refresh attempt (and its failure) is what the test turns on.
            expect(db._mempoolCountCache.BTC.t, 'the count should be cached').to.be.a('number');
            db._mempoolCountCache.BTC.t -= 60 * 60 * 1000;
            expect(await db.getDecoderMempoolCount(cfg())).to.equal(11);
        } finally {
            delete process.env.MEMPOOL_COUNT_CACHE_MS;
        }
    });
});

describe('Database#getFeeEstimate', () => {
    let db, origFetch;
    const FALLBACK = { low: 1, medium: 2, high: 3 };
    beforeEach(() => { db = makeDb(); origFetch = global.fetch; delete process.env.ENCODER_URL; });
    afterEach(() => { sinon.restore(); global.fetch = origFetch; delete process.env.ENCODER_URL; });

    it('returns the conservative fallback when ENCODER_URL is unset', async () => {
        const v = await db.getFeeEstimate(cfg());
        expect(v).to.deep.equal(FALLBACK);
    });

    it('fetches estimate_fee from the coin encoder and returns its tiers', async () => {
        process.env.ENCODER_URL = 'https://encoder.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { low: 5, medium: 10, high: 20 } }) });
        const v = await db.getFeeEstimate(cfg());                       // coin: 'BTC'
        expect(v).to.deep.equal({ low: 5, medium: 10, high: 20 });
        expect(global.fetch.firstCall.args[0]).to.contain('/BTC/');
    });

    it('caches within the TTL (two calls trigger one fetch)', async () => {
        process.env.ENCODER_URL = 'https://encoder.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { low: 1, medium: 1, high: 1 } }) });
        await db.getFeeEstimate(cfg());
        await db.getFeeEstimate(cfg());
        expect(global.fetch.callCount).to.equal(1);
    });

    it('falls back when the encoder is unreachable', async () => {
        process.env.ENCODER_URL = 'https://encoder.example';
        global.fetch = sinon.stub().rejects(new Error('ECONNREFUSED'));
        const v = await db.getFeeEstimate(cfg());
        expect(v).to.deep.equal(FALLBACK);
    });

    it('falls back on a malformed estimate_fee response', async () => {
        process.env.ENCODER_URL = 'https://encoder.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { low: 5 } }) });
        const v = await db.getFeeEstimate(cfg());
        expect(v).to.deep.equal(FALLBACK);
    });
});

describe('Database#getCoinPriceUsd', () => {
    let db, origFetch;
    beforeEach(() => { db = makeDb(); origFetch = global.fetch; delete process.env.HUB_URL; });
    afterEach(() => { sinon.restore(); global.fetch = origFetch; delete process.env.HUB_URL; });

    it('returns null when HUB_URL is unset', async () => {
        expect(await db.getCoinPriceUsd(cfg())).to.equal(null);
    });

    it('fetches getprice for the mainnet coin and returns the price string', async () => {
        process.env.HUB_URL = 'http://hub.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { coin_pair: 'BTC/USD', price: '62807.00000000' } }) });
        const v = await db.getCoinPriceUsd(cfg());                       // coin: 'BTC'
        expect(v).to.equal('62807.00000000');
        const body = JSON.parse(global.fetch.firstCall.args[1].body);
        expect(body.method).to.equal('getprice');
        expect(body.params.coin_pair).to.equal('BTC/USD');
    });

    it('returns null for a testnet/regtest code without calling the hub', async () => {
        process.env.HUB_URL = 'http://hub.example';
        global.fetch = sinon.stub();
        const v = await db.getCoinPriceUsd(cfg({ coin: 'TBTC' }));
        expect(v).to.equal(null);
        expect(global.fetch.called).to.equal(false);
    });

    it('caches within the TTL (two calls trigger one fetch)', async () => {
        process.env.HUB_URL = 'http://hub.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { price: '100.00000000' } }) });
        await db.getCoinPriceUsd(cfg());
        await db.getCoinPriceUsd(cfg());
        expect(global.fetch.callCount).to.equal(1);
    });

    it('returns null when the hub is unreachable', async () => {
        process.env.HUB_URL = 'http://hub.example';
        global.fetch = sinon.stub().rejects(new Error('ECONNREFUSED'));
        expect(await db.getCoinPriceUsd(cfg())).to.equal(null);
    });

    it('returns null on a no-data getprice response', async () => {
        process.env.HUB_URL = 'http://hub.example';
        global.fetch = sinon.stub().resolves({ ok: true, json: async () => ({ result: { error: 'no price data for BTC/USD' } }) });
        expect(await db.getCoinPriceUsd(cfg())).to.equal(null);
    });
});
