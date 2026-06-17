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
 * Unit tests for data-transformation and query-execution methods in src/db.js
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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');
const mockResults              = require('../fixtures/mock-db-results.js');

// ---------------------------------------------------------------------------
// Bootstrap (no real MariaDB pool needed)
// ---------------------------------------------------------------------------

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo    = createConfigInfoStub();
const util          = new Utility(configInfo);
const mockExplorer  = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

// Shared minimal config used across tests
function cfg(overrides = {}) {
    return makeConfig({ coin: 'BTC', ...overrides });
}

// ---------------------------------------------------------------------------
// doQuery
// ---------------------------------------------------------------------------

describe('Database#doQuery', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // Helper: set up db.pools with a mock pool for the given coin key
    function setupMockPool(coin, fakeConn) {
        db.pools = {};
        db.pools[coin] = {
            pool: { getConnection: sinon.stub().resolves(fakeConn) },
            config: {}
        };
    }

    it('returns query results on success', async () => {
        const fakeRows = mockResults.sendRows();
        const fakeConn = {
            query:   sinon.stub().resolves(fakeRows),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        const result = await db.doQuery(cfg(), 'SELECT 1', []);
        expect(result).to.deep.equal(fakeRows);
    });

    it('returns false when a SQL error is thrown', async () => {
        const fakeConn = {
            query:   sinon.stub().rejects(new Error('Table not found')),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        const result = await db.doQuery(cfg(), 'SELECT bad', []);
        expect(result).to.equal(false);
    });

    it('returns false when no pool exists for the coin', async () => {
        db.pools = {};
        const result = await db.doQuery(cfg(), 'SELECT 1', []);
        expect(result).to.equal(false);
    });

    it('always calls release() after a successful query', async () => {
        const fakeConn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        await db.doQuery(cfg(), 'SELECT 1', []);
        expect(fakeConn.release.calledOnce).to.be.true;
    });

    it('always calls release() even after a SQL error', async () => {
        const fakeConn = {
            query:   sinon.stub().rejects(new Error('boom')),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        await db.doQuery(cfg(), 'SELECT 1', []);
        expect(fakeConn.release.calledOnce).to.be.true;
    });

    it('skips query execution when query is null', async () => {
        db.pools = {};
        const result = await db.doQuery(cfg(), null, []);
        expect(result).to.equal(false);
    });
});

// ---------------------------------------------------------------------------
// getData
// ---------------------------------------------------------------------------

describe('Database#getData', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, total] when both data and count queries succeed', async () => {
        const rows      = mockResults.sendRows();
        const countRows = mockResults.countRow(42);
        let   callCount = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callCount++;
            return callCount === 1 ? rows : countRows;
        });
        // Stub getQuery to return a plain SQL string + count query
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, 'SELECT count(*) as total FROM sends']);

        const config = cfg({ data: { method: 'getSends', search: null, query: {}, sql: { where: { data: 'm.action_index IS NOT NULL', offset: '' }, order: 'DESC', limit: 100 }, offset: { action: null, start: null, stop: null } } });
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(rows);
        expect(total).to.equal(42);
    });

    it('returns [data, null] when no count query is provided', async () => {
        const rows = mockResults.sendRows();
        sinon.stub(db, 'doQuery').resolves(rows);
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, '']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(rows);
        expect(total).to.be.null;
    });

    it('returns [[], null] when query is empty string', async () => {
        sinon.stub(db, 'getQuery').resolves(['', null, '']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal([]);
        expect(total).to.be.null;
    });

    it('passes object query directly as data without calling doQuery', async () => {
        const objectData = { custom: true };
        sinon.stub(db, 'getQuery').resolves([objectData, null, null]);
        const doQueryStub = sinon.stub(db, 'doQuery');

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(objectData);
        expect(doQueryStub.called).to.be.false;
        expect(total).to.be.null;
    });

    it('returns numeric count from object query when count is numeric', async () => {
        const objectData = [{ id: 1 }];
        sinon.stub(db, 'getQuery').resolves([objectData, null, 99]);
        sinon.stub(db, 'doQuery');

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(total).to.equal(99);
    });

    it('returns [false, 0] when doQuery returns false and count query exists', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, 'SELECT count(*) as total FROM x']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.equal(false);
        expect(total).to.equal(0);
    });
});

// ---------------------------------------------------------------------------
// getAddress
// ---------------------------------------------------------------------------

describe('Database#getAddress', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // getAddress now appends controller bindings; stub the lookup so these
        // header-shape assertions don't need a live pool (covered separately).
        sinon.stub(db, 'getAddressControllerBindings').resolves([]);
    });
    afterEach(() => { sinon.restore(); });

    it('returns a data object with the expected top-level keys', async () => {
        const config = cfg({ data: { search: 'addr1bc' } });
        const [data] = await db.getAddress(config);
        // controllers is the Controller_Bound_Tokens.md display surface; with no
        // binding it resolves to []
        expect(data).to.have.keys(['address', 'type', 'balances', 'utxos', 'estimated_value', 'controllers']);
        expect(data.controllers).to.deep.equal([]);
    });

    it('echoes the search address into data.address', async () => {
        const config = cfg({ data: { search: 'bc1qtest' } });
        const [data] = await db.getAddress(config);
        expect(data.address).to.equal('bc1qtest');
    });

    it('returns balances with confirmed, pending, received fields', async () => {
        const config = cfg({ data: { search: 'addr' } });
        const [data] = await db.getAddress(config);
        expect(data.balances).to.have.keys(['confirmed', 'pending', 'received']);
    });

    it('returns utxos with confirmed and pending fields', async () => {
        const config = cfg({ data: { search: 'addr' } });
        const [data] = await db.getAddress(config);
        expect(data.utxos).to.have.keys(['confirmed', 'pending']);
    });
});

// ---------------------------------------------------------------------------
// getBlock
// ---------------------------------------------------------------------------

describe('Database#getBlock', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the first result row when query succeeds', async () => {
        const row = mockResults.blockRow()[0];
        sinon.stub(db, 'doQuery').resolves([row]);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.deep.equal(row);
    });

    it('returns null when no rows found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const config = cfg({ data: { search: '9999', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.be.null;
    });

    it('includes expected block fields in the result', async () => {
        const row = mockResults.blockRow()[0];
        sinon.stub(db, 'doQuery').resolves([row]);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.include.keys(['block_index', 'timestamp', 'ledger_hash', 'actions_hash', 'contract_hash']);
    });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('Database#getStatus', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an object that includes supported and available keys', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.include.keys(['supported', 'available']);
    });

    it('returns the COIN_SUPPORTED map from config', async () => {
        const config  = cfg();
        const [data]  = await db.getStatus(config);
        const fullCfg = await configInfo.getConfig();
        expect(data.supported).to.deep.equal(fullCfg['COIN_SUPPORTED']);
    });

    it('returns the COIN_AVAILABLE map from config', async () => {
        const config  = cfg();
        const [data]  = await db.getStatus(config);
        const fullCfg = await configInfo.getConfig();
        expect(data.available).to.deep.equal(fullCfg['COIN_AVAILABLE']);
    });

    it('returns last_block as an object', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.have.property('last_block').that.is.an('object');
    });

    it('returns last_block_time as an object', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.have.property('last_block_time').that.is.an('object');
    });

    it('populates last_block and last_block_time with numeric values for each available coin that has an active pool', async () => {
        db.pools = {};
        db.pools['RBTC'] = {
            pool: {
                getConnection: sinon.stub().resolves({
                    query:   sinon.stub().resolves([{ max_index: 850, block_time: 1700000000 }]),
                    release: sinon.stub().resolves()
                })
            },
            config: {}
        };
        const config = cfg({ coin: 'RBTC' });
        const [data] = await db.getStatus(config);
        expect(data.last_block).to.have.property('RBTC');
        expect(data.last_block['RBTC']).to.be.a('number');
        expect(data.last_block_time).to.have.property('RBTC');
        expect(data.last_block_time['RBTC']).to.be.a('number');
    });

    it('sets last_block[coin]/last_block_time[coin] to 0 when the blocks table is empty (simulates indexer behind tip)', async () => {
        db.pools = {};
        db.pools['RBTC'] = {
            pool: {
                getConnection: sinon.stub().resolves({
                    query:   sinon.stub().resolves([{ max_index: null, block_time: null }]),
                    release: sinon.stub().resolves()
                })
            },
            config: {}
        };
        const config = cfg({ coin: 'RBTC' });
        const [data] = await db.getStatus(config);
        expect(data.last_block).to.have.property('RBTC', 0);
        expect(data.last_block_time).to.have.property('RBTC', 0);
    });

    it('excludes coins from last_block/last_block_time when they have no active pool', async () => {
        // No pools set up: even COIN_AVAILABLE coins are absent from both maps
        db.pools = {};
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(Object.keys(data.last_block)).to.have.lengthOf(0);
        expect(Object.keys(data.last_block_time)).to.have.lengthOf(0);
    });
});

// ---------------------------------------------------------------------------
// getMempool
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getNetwork
// ---------------------------------------------------------------------------

describe('Database#getNetwork', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns object with totals, network, fee, coin, xchain, finality keys', async () => {
        // Each table lookup returns [{ count: 5 }]
        sinon.stub(db, 'doQuery').resolves([{ count: 5 }]);

        const config = cfg();
        const [data] = await db.getNetwork(config);
        expect(data).to.have.keys(['totals', 'network', 'fee', 'coin', 'xchain', 'finality']);
    });

    it('populates totals for every actionTable plus tokens', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 3 }]);

        const config  = cfg();
        const [data]  = await db.getNetwork(config);
        const expected = [...db.actionTables, 'tokens'];
        for(const table of expected){
            expect(data.totals).to.have.property(table);
        }
    });

    it('sets totals to the count values returned by doQuery', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 7 }]);

        const config = cfg();
        const [data] = await db.getNetwork(config);
        for(const key in data.totals){
            expect(data.totals[key]).to.equal(7);
        }
    });

    it('skips a table count when doQuery returns false for it', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg();
        const [data] = await db.getNetwork(config);
        // No totals should be set when every doQuery call fails
        expect(Object.keys(data.totals)).to.have.length(0);
    });

    it('reports the real indexer tip + last-block time as network.block/time', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 1 }]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(800000);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);

        const [data] = await db.getNetwork(cfg());
        expect(data.network).to.have.keys(['block', 'time', 'unconfirmed']);
        expect(data.network.block).to.equal(800000);
        expect(data.network.time).to.equal(1700000000);
        // Mempool isn't indexed yet, so unconfirmed is 0 rather than a fake value.
        expect(data.network.unconfirmed).to.equal(0);
    });

    it('resolves coin name + symbol from the per-coin chain config', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 1 }]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        sinon.stub(db, 'getMaxBlockTime').resolves(0);

        const [data] = await db.getNetwork(cfg());            // coin: 'BTC'
        expect(data.coin.name).to.equal('Bitcoin');
        expect(data.coin.symbol).to.equal('BTC');
    });

    it('does not hardcode Bitcoin: a coin absent from config falls back to its own code', async () => {
        sinon.stub(db, 'doQuery').resolves([{ count: 1 }]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        sinon.stub(db, 'getMaxBlockTime').resolves(0);

        const [data] = await db.getNetwork(cfg({ coin: 'LTC' }));
        expect(data.coin.name).to.not.equal('Bitcoin');
        expect(data.coin.symbol).to.equal('LTC');
    });
});

// ---------------------------------------------------------------------------
// getDecoderMempoolCount
// ---------------------------------------------------------------------------

describe('Database#getDecoderMempoolCount', () => {
    let db;
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
});

// ---------------------------------------------------------------------------
// getFeeEstimate
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getCoinPriceUsd
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getToken
// ---------------------------------------------------------------------------

describe('Database#getToken', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when no token found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const config = cfg({ data: { search: 'MISSING' } });
        const [data] = await db.getToken(config);
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data).to.be.null;
    });

    it('returns an object with info, callback, market, lists, locks, mints, supply, projects, registry keys', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // projects/registry are the Project_Registry.md display surfaces; with
        // no baseCoin map (un-inited db) they resolve to []/null. controllers is
        // the Controller_Bound_Tokens.md surface (→ [] with no pool/tick id).
        expect(data).to.have.keys(['info', 'callback', 'market', 'lists', 'locks', 'mints', 'supply', 'projects', 'registry', 'controllers']);
        expect(data.projects).to.deep.equal([]);
        expect(data.registry).to.equal(null);
        expect(data.controllers).to.deep.equal([]);
    });

    it('maps lock_max_supply="1" to locks.max_supply === true', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.locks.max_supply).to.be.true;
    });

    it('maps lock_mint="0" to locks.mint === false', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.locks.mint).to.be.false;
    });

    it('formats supply.current with bcformat using decimals', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ coin: 'BTC', data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // tokenRow supply='1000000', decimals=8 → '1000000.00000000'
        expect(data.supply.current).to.equal('1000000.00000000');
    });

    it('formats supply.max with bcformat using decimals', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ coin: 'BTC', data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.supply.max).to.equal('21000000.00000000');
    });

    it('groups allow_list into lists.allow', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // allow_list is null in tokenRow
        expect(data.lists).to.have.property('allow');
    });

    it('groups block_list into lists.block', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.lists).to.have.property('block');
    });

    it('groups coin_price into market.price', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.market.price).to.equal(100);
    });

    it('groups coin_floor into market.floor', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.market.floor).to.equal(50);
    });

    it('groups max_mint into mints.max', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // max_mint key → replace('_mint','') = 'max'
        expect(data.mints.max).to.equal(100);
    });

    it('groups mint_address_max into mints.address_max', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // mint_address_max → replace('mint_','') = 'address_max'
        expect(data.mints.address_max).to.equal(0);
    });

    it('groups callback_block into callback.block', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.callback.block).to.equal(0);
    });

    it('exposes the token decimals (but never callback_decimals) in info + supply', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // decimals power client-side NFT-pattern classification (DECIMALS=0 +
        // LOCK_MAX_SUPPLY=1, see NFT_Standard.md); callback_decimals stays internal
        expect(data.info.decimals).to.equal(8);
        expect(data.supply.decimals).to.equal(8);
        expect(data.info).to.not.have.property('callback_decimals');
    });

    it('places tick and owner in data.info', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.tick).to.equal('XCHAIN');
        expect(data.info.owner).to.equal('ownerAddr1');
    });

    it('places description in data.info', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.description).to.equal('XChain Gas Token');
    });
});

// ---------------------------------------------------------------------------
// getTransaction
// ---------------------------------------------------------------------------

describe('Database#getTransaction', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns a data object with tx_index, tx_hash, block_index, timestamp, source, actions, tx_data', async () => {
        const txRow      = mockResults.transactionRow();
        const actionRows = mockResults.actionRows();

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            if(call === 1) return txRow;       // transaction lookup
            if(call === 2) return actionRows;  // actions lookup
            return [];
        });
        // Stub helper methods that would require their own DB calls
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (cfg, actions) => actions);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data).to.have.property('tx_index', 1);
        expect(data).to.have.property('tx_hash', 'abc123');
        expect(data).to.have.property('block_index', 500);
        expect(data).to.have.property('actions').that.is.an('array');
    });

    it('populates data.actions from the second doQuery call', async () => {
        const txRow      = mockResults.transactionRow();
        const actionRows = mockResults.actionRows();

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            if(call === 1) return txRow;
            if(call === 2) return actionRows;
            return [];
        });
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (cfg, actions) => actions);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.actions).to.have.length(2);
        expect(data.actions[0].action_index).to.equal(100);
    });

    it('sets tx_data to null when getTransactionData returns null', async () => {
        sinon.stub(db, 'doQuery').callsFake(async () => mockResults.transactionRow());
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.tx_data).to.be.null;
    });

    it('sets tx_data from getTransactionData when it returns a row with .data', async () => {
        const txRow     = mockResults.transactionRow();
        const decoderRow = { tx_index: 1, block_index: 500, hash: 'abc123', fee: 1000, amount: 50000, data: 'XCHN...' };

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            return call === 1 ? txRow : mockResults.actionRows();
        });
        sinon.stub(db, 'getTransactionData').resolves(decoderRow);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.tx_data).to.equal('XCHN...');
    });

    it('returns empty actions array when first doQuery returns no transaction', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'notfound', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.actions).to.deep.equal([]);
    });
});

// ---------------------------------------------------------------------------
// getAddressId
// ---------------------------------------------------------------------------

describe('Database#getAddressId', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the id when address is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.addressIdRow());

        const id = await db.getAddressId(cfg(), 'addr1');
        expect(id).to.equal(42);
    });

    it('returns null when address is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const id = await db.getAddressId(cfg(), 'unknown');
        expect(id).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const id = await db.getAddressId(cfg(), 'addr1');
        expect(id).to.be.null;
    });
});

// ---------------------------------------------------------------------------
// getTickId
// ---------------------------------------------------------------------------

describe('Database#getTickId', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the id when tick is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tickIdRow());

        const id = await db.getTickId(cfg(), 'XCHAIN');
        expect(id).to.equal(7);
    });

    it('returns null when tick is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const id = await db.getTickId(cfg(), 'MISSING');
        expect(id).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const id = await db.getTickId(cfg(), 'XCHAIN');
        expect(id).to.be.null;
    });
});

// ---------------------------------------------------------------------------
// getActionType
// ---------------------------------------------------------------------------

describe('Database#getActionType', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the action type string when action_index is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.actionTypeRow('SEND'));

        const type = await db.getActionType(cfg(), 100);
        expect(type).to.equal('SEND');
    });

    it('returns null when action_index is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const type = await db.getActionType(cfg(), 9999);
        expect(type).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const type = await db.getActionType(cfg(), 100);
        expect(type).to.be.null;
    });

    it('returns different action types correctly', async () => {
        const types = ['ISSUE', 'MINT', 'DISPENSER', 'ORDER', 'SWEEP'];
        for(const expected of types){
            sinon.restore();
            const db2 = makeDb();
            sinon.stub(db2, 'doQuery').resolves(mockResults.actionTypeRow(expected));
            const type = await db2.getActionType(cfg(), 1);
            expect(type).to.equal(expected);
        }
    });
});

// ---------------------------------------------------------------------------
// getToken: escrow_action_index exposure
// ---------------------------------------------------------------------------

describe('Database#getToken escrow_action_index', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('selects t1.escrow_action_index and surfaces it under info', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (cfgArg, query) => {
            // getToken now also runs follow-up lookups (tick id, controller
            // bindings); capture only the main token SELECT.
            if(query.includes('FROM\n                        tokens t1'))
                captured = query;
            const rows = mockResults.tokenRow();
            rows[0].escrow_action_index = 4242;
            return rows;
        });
        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(captured).to.include('t1.escrow_action_index');
        expect(data.info.escrow_action_index).to.equal(4242);
    });

    it('is null for a token whose ownership is not escrowed', async () => {
        sinon.stub(db, 'doQuery').callsFake(async () => {
            const rows = mockResults.tokenRow();
            rows[0].escrow_action_index = null;
            return rows;
        });
        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.escrow_action_index).to.be.null;
    });
});

// ---------------------------------------------------------------------------
// getStatus: chain to decoder health aggregation
// ---------------------------------------------------------------------------

describe('Database#getStatus decoder health aggregation', () => {
    const axios = require('axios');
    const ENV_KEYS = ['DECODER_API_URL', 'DECODER_API_URL_BTC_MAINNET'];
    let db, saved;

    beforeEach(() => {
        db = makeDb();
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    it('reports decoder_health=unconfigured with null chain fields when no URL is set', async () => {
        const [data] = await db.getStatus(cfg());
        expect(data).to.include.keys(['chain_tip', 'chain_lag_blocks', 'decoder_health']);
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('unconfigured');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });

    it('surfaces chain_tip / chain_lag_blocks / status from the decoder health call', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7 } }
        });
        const [data] = await db.getStatus(cfg());
        const codes = Object.keys(data.decoder_health);
        expect(codes.length).to.be.greaterThan(0);
        for (const code of codes) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    it('reports decoder_health=unreachable (null fields) when the health call fails', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'));
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('unreachable');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });
});

// ---------------------------------------------------------------------------
// getContract: single-record data method + permissions manifest LEFT JOIN
// (protocol/Controller_Bound_Tokens.md)
// ---------------------------------------------------------------------------

describe('Database#getContract', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // A minimal contract row as returned by the SELECT (manifest columns vary).
    function contractRow(overrides = {}) {
        return Object.assign({
            action:            'DEPLOY',
            action_index:      900,
            action_format:     0,
            source:            'deployerAddr',
            code:              'module.exports={}',
            code_hash:         'abc123',
            api_version:       1,
            cooldown_blocks:   null,
            slash_destination: null,
            block_index:       500,
            timestamp:         1700000000,
            tx_hash:           'tx900',
            tx_index:          90,
            status:            'valid',
            permissions:       null,
            max_take_bps:      null
        }, overrides);
    }

    const baseCfg = () => cfg({ data: { search: '900', sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 } } });

    it('returns null when no contract found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const [data] = await db.getContract(baseCfg());
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        const [data] = await db.getContract(baseCfg());
        expect(data).to.be.null;
    });

    it('returns the contract row with permissions=null / max_take_bps=null when no manifest', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow()]);
        const [data] = await db.getContract(baseCfg());
        expect(data.action_index).to.equal(900);
        expect(data.permissions).to.equal(null);
        expect(data.max_take_bps).to.equal(null);
    });

    it('parses a JSON permissions array and coerces max_take_bps to a number', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: '["send","mint"]', max_take_bps: '300' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.deep.equal(['send', 'mint']);
        expect(data.max_take_bps).to.equal(300);
    });

    it('falls back to permissions=null on malformed JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: 'not json' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.equal(null);
    });

    it('preserves an empty permissions array ("emits nothing")', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: '[]' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.deep.equal([]);
    });

    it('LEFT JOINs contract_permissions on the contract action_index', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (c, query) => { captured = query; return [contractRow()]; });
        await db.getContract(baseCfg());
        expect(captured).to.include('LEFT  JOIN contract_permissions cp');
        expect(captured).to.include('cp.contract_index=m.action_index');
    });
});

// ---------------------------------------------------------------------------
// getContractManifest (protocol/Controller_Bound_Tokens.md)
// ---------------------------------------------------------------------------

describe('Database#getContractManifest', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when the contract has no manifest row', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getContractManifest(cfg(), 900)).to.equal(null);
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        expect(await db.getContractManifest(cfg(), 900)).to.equal(null);
    });

    it('returns null without querying for a null contract index', async () => {
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getContractManifest(cfg(), null)).to.equal(null);
        expect(q.called).to.be.false;
    });

    it('parses permissions JSON and coerces max_take_bps', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '["send"]', max_take_bps: '250' }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m).to.deep.equal({ permissions: ['send'], max_take_bps: 250 });
    });

    it('returns permissions=null (unrestricted) but a real max_take_bps', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: null, max_take_bps: '100' }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.equal(null);
        expect(m.max_take_bps).to.equal(100);
    });

    it('returns max_take_bps=null (global cap) when not set', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '[]', max_take_bps: null }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.deep.equal([]);
        expect(m.max_take_bps).to.equal(null);
    });

    it('falls back to permissions=null on malformed JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '{oops', max_take_bps: null }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.equal(null);
    });
});

// ---------------------------------------------------------------------------
// Controller bindings: read-time cooldown reduction
// (protocol/Controller_Bound_Tokens.md). Mirrors the indexer's
// readEffectiveControllerMap / controllerEventIfGating.
// ---------------------------------------------------------------------------

describe('Database#getTokenControllerBindings', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // event() builds a token_controllers row.
    function event(o) {
        return Object.assign({
            action_class: 'transfer', action_index: 1, contract_index: 50,
            is_unbind: 0, cooldown_blocks: 0, cooldown_end_block: null, block_index: 100
        }, o);
    }

    it('returns [] when the tick has no events', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTokenControllerBindings(cfg(), 'XCHAIN')).to.deep.equal([]);
    });

    it('returns [] when the tick id is unknown', async () => {
        sinon.stub(db, 'getTickId').resolves(null);
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getTokenControllerBindings(cfg(), 'NOPE')).to.deep.equal([]);
        // _resolveControllerBindings short-circuits on a null key (no event query)
        expect(q.called).to.be.false;
    });

    it('surfaces an active bind with the shared binding shape', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([event({ action_class: 'trade', contract_index: 88, cooldown_blocks: 10, block_index: 120 })]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(200);
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.deep.equal([{
            action_class: 'trade', contract_index: 88, cooldown_blocks: 10, is_unbind: 0, bind_block: 120, bound_by: null
        }]);
    });

    it('latest event per action_class wins (a later bind supersedes an earlier one)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'transfer', action_index: 1, contract_index: 50 }),
            event({ action_class: 'transfer', action_index: 5, contract_index: 99 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(500);
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.have.lengthOf(1);
        expect(out[0].contract_index).to.equal(99);
    });

    it('an unbind still in cooldown gates (tip < cooldown_end_block)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'burn', action_index: 1, contract_index: 50 }),
            event({ action_class: 'burn', action_index: 2, is_unbind: 1, cooldown_blocks: 100, cooldown_end_block: 300, block_index: 200 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(250); // 250 < 300 → still gating
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.have.lengthOf(1);
        expect(out[0].is_unbind).to.equal(1);
    });

    it('an unbind past its cooldown no longer gates (tip >= cooldown_end_block)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'burn', action_index: 1, contract_index: 50 }),
            event({ action_class: 'burn', action_index: 2, is_unbind: 1, cooldown_blocks: 100, cooldown_end_block: 300, block_index: 200 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(300); // 300 >= 300 → expired
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.deep.equal([]);
    });

    it('an unbind with a NULL cooldown_end_block never gates', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'mint', action_index: 9, is_unbind: 1, cooldown_end_block: null })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        expect(await db.getTokenControllerBindings(cfg(), 'XCHAIN')).to.deep.equal([]);
    });
});

describe('Database#getAddressControllerBindings', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('resolves the address id and returns the gating bindings', async () => {
        sinon.stub(db, 'getAddressId').resolves(42);
        sinon.stub(db, 'doQuery').resolves([{
            action_class: 'stake', action_index: 3, contract_index: 77,
            is_unbind: 0, cooldown_blocks: 5, cooldown_end_block: null, block_index: 130
        }]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(400);
        const out = await db.getAddressControllerBindings(cfg(), 'addr1');
        expect(out).to.deep.equal([{
            action_class: 'stake', contract_index: 77, cooldown_blocks: 5, is_unbind: 0, bind_block: 130, bound_by: null
        }]);
    });

    it('returns [] for an unknown address without querying events', async () => {
        sinon.stub(db, 'getAddressId').resolves(null);
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getAddressControllerBindings(cfg(), 'ghost')).to.deep.equal([]);
        expect(q.called).to.be.false;
    });
});
