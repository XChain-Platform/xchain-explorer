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

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo    = createConfigInfoStub();
const util          = new Utility(configInfo);
const mockExplorer  = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

function cfg(overrides = {}) {
    return makeConfig({ coin: 'BTC', ...overrides });
}

describe('Database#doQuery', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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

    it('throws DbQueryError when a SQL error is thrown rather than reading as an empty result', async () => {
        const fakeConn = {
            query:   sinon.stub().rejects(new Error('Table not found')),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        let err = null;
        try { await db.doQuery(cfg(), 'SELECT bad', []); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.name).to.equal('DbQueryError');
        expect(err.code).to.equal('DB_ERROR');
    });

    it('throws DbQueryError when no pool exists for the coin', async () => {
        db.pools = {};
        let err = null;
        try { await db.doQuery(cfg(), 'SELECT 1', []); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.name).to.equal('DbQueryError');
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

        // doQuery rethrows the failure so an outage surfaces as an error, not silently
        // as empty data; release() must still run via finally.
        try { await db.doQuery(cfg(), 'SELECT 1', []); } catch (e) { /* expected */ }
        expect(fakeConn.release.calledOnce).to.be.true;
    });

    it('skips query execution when query is null', async () => {
        db.pools = {};
        const result = await db.doQuery(cfg(), null, []);
        expect(result).to.equal(false);
    });
});

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

describe('Database#getAddress', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // getAddress appends controller bindings AND surfaces info.address_id (the latter
        // via getCompactableAddressId -> doQuery, F3). Stub both so these header-shape
        // assertions don't need a live pool. doQuery -> [] => info.address_id null.
        sinon.stub(db, 'getAddressControllerBindings').resolves([]);
        sinon.stub(db, 'doQuery').resolves([]);
    });
    afterEach(() => { sinon.restore(); });

    it('returns a data object with the expected top-level keys', async () => {
        const config = cfg({ data: { search: 'addr1bc' } });
        const [data] = await db.getAddress(config);
        // controllers surfaces the address's active controller bindings ([] with no binding);
        // info carries the SDK-facing address/address_id (F3, see below).
        // tracker_available flags whether this coin's xchain-utxo-tracker answered (false here:
        // no tracker stubbed, so balances/utxos stay null and the page shows "Unavailable").
        expect(data).to.have.keys(['address', 'type', 'balances', 'utxos', 'estimated_value', 'tracker_available', 'controllers', 'info']);
        expect(data.controllers).to.deep.equal([]);
        // F3: no deterministic id resolved (doQuery -> []) => address_id is null, not compacted.
        expect(data.info).to.deep.equal({ address: 'addr1bc', address_id: null });
    });

    it('surfaces a deterministic index id under info.address_id when one exists (F3)', async () => {
        db.doQuery.restore();
        sinon.stub(db, 'doQuery').resolves([{ id: 99 }]);   // block_index-stamped id
        const [data] = await db.getAddress(cfg({ data: { search: 'bc1qDet' } }));
        expect(data.info.address_id).to.equal(99);
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
        db.pools = {};
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(Object.keys(data.last_block)).to.have.lengthOf(0);
        expect(Object.keys(data.last_block_time)).to.have.lengthOf(0);
    });
});

// The freshness gate that stops a frozen replica advertising itself as available.
// decoder_lag_blocks cannot see a JOINT indexer+decoder freeze (it is an intra-replica
// difference that reads 0 in that state), so the gate measures wall-clock instead.
describe('Database tip-freshness gate', () => {
    let db;
    const ENV_KEYS = ['EXPLORER_TIP_MAX_AGE_S', 'EXPLORER_TIP_MAX_AGE_S_RBTC',
                      'EXPLORER_TIP_MAX_FUTURE_SKEW_S', 'EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC'];
    let savedEnv;

    beforeEach(() => {
        db = makeDb();
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        sinon.restore();
    });

    // Returns a pool whose every query answers with this block_time.
    function poolWithBlockTime(coin, blockTime) {
        db.pools = {};
        db.pools[coin] = {
            pool: {
                getConnection: sinon.stub().resolves({
                    query:   sinon.stub().resolves([{ max_index: 850, block_time: blockTime }]),
                    release: sinon.stub().resolves()
                })
            },
            config: {}
        };
    }

    describe('#tipMaxAgeSeconds', () => {
        it('defaults to 6 hours when no env override is set', () => {
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(21600);
        });

        it('honours the global EXPLORER_TIP_MAX_AGE_S override', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = '120';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(120);
        });

        it('lets a per-coin override win over the global one', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S      = '120';
            process.env.EXPLORER_TIP_MAX_AGE_S_RBTC = '900';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(900);
            expect(db.tipMaxAgeSeconds('BTC')).to.equal(120);
        });

        it('ignores a non-numeric override rather than reading it as 0 (which would disable the gate)', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = 'off';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(21600);
        });
    });

    describe('#tipMaxFutureSkewSeconds', () => {
        it('defaults to 2 hours when no env override is set', () => {
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(7200);
        });

        it('honours the global override and lets a per-coin override win', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S      = '60';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(60);
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '900';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(900);
            expect(db.tipMaxFutureSkewSeconds('BTC')).to.equal(60);
        });

        it('ignores a non-numeric override rather than reading it as 0 (which would disable the check)', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S = 'off';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(7200);
        });
    });

    describe('#isTipStale', () => {
        const NOW = 1800000000;

        it('is false for a tip inside the window', () => {
            expect(db.isTipStale('RBTC', NOW - 60, NOW)).to.equal(false);
        });

        it('is true for a tip past the window', () => {
            expect(db.isTipStale('RBTC', NOW - 21601, NOW)).to.equal(true);
        });

        it('fails closed on a 0 / null / non-numeric block_time', () => {
            expect(db.isTipStale('RBTC', 0, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', null, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', 'soon', NOW)).to.equal(true);
        });

        it('is disabled by an explicit 0 threshold, even for a missing block_time', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = '0';
            expect(db.isTipStale('RBTC', NOW - 999999, NOW)).to.equal(false);
            expect(db.isTipStale('RBTC', null, NOW)).to.equal(false);
        });

        // Skew inside the tolerance stays healthy; past it the tip stops counting
        // as evidence of freshness at all.
        it('tolerates a tip dated modestly ahead of the host clock', () => {
            expect(db.isTipStale('RBTC', NOW + 6649, NOW)).to.equal(false);
        });

        it('is true for a tip dated further ahead than the skew tolerance allows', () => {
            expect(db.isTipStale('RBTC', NOW + 7201, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', NOW + 86400 * 365, NOW)).to.equal(true);
        });

        it('honours a per-coin skew tolerance and its explicit 0 opt-out', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '60';
            expect(db.isTipStale('RBTC', NOW + 61, NOW)).to.equal(true);
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '0';
            expect(db.isTipStale('RBTC', NOW + 86400 * 365, NOW)).to.equal(false);
        });
    });

    describe('#isCoinTipStale', () => {
        it('reads the indexer tip and caches the verdict', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            expect(await db.isCoinTipStale('RBTC')).to.equal(false);
            const calls = db.pools['RBTC'].pool.getConnection.callCount;
            expect(await db.isCoinTipStale('RBTC')).to.equal(false);
            expect(db.pools['RBTC'].pool.getConnection.callCount).to.equal(calls);   // served from cache
        });

        it('fails closed when the indexer read throws', async () => {
            sinon.stub(db, 'getMaxBlockTime').rejects(new Error('db down'));
            expect(await db.isCoinTipStale('RBTC')).to.equal(true);
        });
    });

    describe('#getStatus availability gating', () => {
        it('drops a coin with a stale tip from `available` while leaving it `supported`', async () => {
            poolWithBlockTime('RBTC', 1700000000);            // years old
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale).to.have.property('RBTC', true);
            expect(data.tip_age_seconds['RBTC']).to.be.above(21600);
            expect(data.available).to.not.have.property('RBTC');
            expect(data.supported).to.have.property('RBTC');   // still a known coin
        });

        it('keeps a coin with a fresh tip available', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale).to.have.property('RBTC', false);
            expect(data.available).to.have.property('RBTC');
        });

        it('does not mutate the shared hub-config COIN_AVAILABLE map when it drops a coin', async () => {
            poolWithBlockTime('RBTC', 1700000000);
            const [data]  = await db.getStatus(cfg({ coin: 'RBTC' }));
            const fullCfg = await configInfo.getConfig();
            expect(data.available).to.not.have.property('RBTC');
            expect(fullCfg['COIN_AVAILABLE']).to.have.property('RBTC');
        });

        it('leaves an unmeasured coin (no pool here) alone rather than delisting it', async () => {
            db.pools = {};
            const [data]  = await db.getStatus(cfg());
            const fullCfg = await configInfo.getConfig();
            expect(data.available).to.deep.equal(fullCfg['COIN_AVAILABLE']);
            expect(Object.keys(data.stale)).to.have.lengthOf(0);
        });

        it('reports tip_age_seconds 0 and the skew in tip_future_seconds for a future-dated tip', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 6649);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(0);
            expect(data.tip_future_seconds['RBTC']).to.be.within(6640, 6649);
            expect(data.stale).to.have.property('RBTC', false);   // inside the tolerance
            expect(data.available).to.have.property('RBTC');
        });

        it('classes a tip dated far ahead as stale instead of letting it read fresher than fresh', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 86400 * 30);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(0);
            expect(data.tip_future_seconds['RBTC']).to.be.above(7200);
            expect(data.stale).to.have.property('RBTC', true);
            expect(data.available).to.not.have.property('RBTC');
        });

        it('reports tip_future_seconds 0 for an ordinary past-dated tip, and null when block_time is unusable', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            let [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_future_seconds['RBTC']).to.equal(0);
            poolWithBlockTime('RBTC', null);
            [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(null);
            expect(data.tip_future_seconds['RBTC']).to.equal(null);
        });

        it('never publishes a negative tip_age_seconds for any measured coin', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 99999);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            for (const [coin, age] of Object.entries(data.tip_age_seconds)) {
                expect(age === null || age >= 0, `tip_age_seconds[${coin}] = ${age}`).to.equal(true);
            }
        });
    });

    // The published schema is the contract third parties code against, and it is
    // served as a static asset that no other suite compares to the producer. That is
    // how it kept describing `available` as a fixed config echo for the whole life of
    // the freshness gate. Pinning it to getStatus makes the next field addition fail
    // here instead of shipping a wrong contract.
    describe('published OpenAPI contract for /status', () => {
        const status = require('../../src/content/json/xchain-platform-api.json')
                        .components.schemas.ExplorerStatus;

        it('documents every field getStatus returns, and no field it does not', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            const [data]   = await db.getStatus(cfg({ coin: 'RBTC' }));
            const returned = Object.keys(data).sort();
            const declared = Object.keys(status.properties).sort();
            expect(returned.filter((k) => !declared.includes(k)),
                'fields /status returns that ExplorerStatus does not declare').to.deep.equal([]);
            expect(declared.filter((k) => !returned.includes(k)),
                'fields ExplorerStatus declares that /status does not return').to.deep.equal([]);
        });

        it('describes available as gate-filtered rather than a static config echo', () => {
            expect(status.properties.available.description).to.match(/stale/i);
            expect(status.properties.available.description).to.match(/supported/);
        });

        it('describes stale and tip_age_seconds, including the fail-closed default', () => {
            expect(status.properties.stale.description).to.match(/EXPLORER_TIP_MAX_AGE_S/);
            expect(status.properties.stale.description).to.match(/21600/);
            expect(status.properties.stale.description).to.match(/available/);
            expect(status.properties.stale.additionalProperties.type).to.equal('boolean');
            expect(status.properties.tip_age_seconds.description).to.match(/seconds/i);
            expect(status.properties.tip_age_seconds.additionalProperties.type)
                .to.deep.equal(['integer', 'null']);
        });

        it('states that tip_age_seconds is never negative and that tip_future_seconds carries the skew', () => {
            expect(status.properties.tip_age_seconds.description).to.match(/never negative|non-negative/i);
            expect(status.properties.tip_age_seconds.description).to.match(/tip_future_seconds/);
            expect(status.properties.tip_future_seconds.description).to.match(/ahead/i);
            expect(status.properties.tip_future_seconds.description).to.match(/EXPLORER_TIP_MAX_FUTURE_SKEW_S/);
            expect(status.properties.tip_future_seconds.additionalProperties.type)
                .to.deep.equal(['integer', 'null']);
        });
    });

    // replica_halted publishes xchain-sync's durable consensus-divergence halt
    // (sync_halt, cleared_at IS NULL) beside `stale`, since a halted replica keeps
    // reporting a small lag until its source mints past it and neither `stale` nor
    // tip_age_seconds can see that state (2026-08-10: two chains sat halted a full
    // day while every existing instrument read green). null must never collapse to
    // false: a consumer reads false as healthy, and this field exists precisely
    // because an absent signal was mistaken for a good one.
    describe('Database#getStatus replica_halted (fail-closed halt signal)', () => {
        let db;
        beforeEach(() => { db = makeDb(); });
        afterEach(() => { sinon.restore(); });

        // Marks the coin as measured (getStatus's per-coin gate only runs for a
        // coin with a live pool); doQuery is stubbed directly below so no real
        // connection is ever opened through this placeholder pool object.
        function markPooled(coin) {
            db.pools = {};
            db.pools[coin] = { pool: {}, config: {} };
        }

        // Dispatches by SQL text so the same stub answers the existence check,
        // the halt-row read, AND the unrelated last_block/last_block_time queries
        // getStatus also issues in the same per-coin pass. A fresh block_time
        // keeps `stale` out of the way of these assertions.
        function stubQueries({ tableExists = true, activeHalt = false, failOn = null } = {}) {
            return sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
                if (/information_schema\.TABLES/.test(query)) {
                    if (failOn === 'exists') throw new Error('existence check failed');
                    return tableExists ? [{ 1: 1 }] : [];
                }
                if (/FROM sync_halt/.test(query)) {
                    if (failOn === 'halt') throw new Error('halt read failed');
                    expect(query).to.match(/cleared_at IS NULL/);
                    expect(args).to.deep.equal(['indexer']);
                    return activeHalt ? [{ id: 1 }] : [];
                }
                if (/MAX\(block_index\)/.test(query)) return [{ max_index: 850 }];
                if (/block_time/.test(query)) return [{ block_time: Math.floor(Date.now() / 1000) - 60 }];
                return [];
            });
        }

        it('reads true when an active (uncleared) halt row exists', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: true });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted).to.have.property('RBTC', true);
        });

        it('reads false when the table was read successfully and holds no active halt', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: false });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted).to.have.property('RBTC', false);
        });

        it('reads null, never false, when the sync_halt table does not exist', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: false });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });

        it('reads null, never false, when the table-existence check itself fails', async () => {
            markPooled('RBTC');
            stubQueries({ failOn: 'exists' });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });

        it('reads null, never false, when the halt-row read fails after the table is confirmed present', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, failOn: 'halt' });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });

        it('does not remove a halted coin from `available` (stale composes separately, out of scope here)', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: true });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.available).to.have.property('RBTC');
        });

        it('reads null directly (no pool for the coin) rather than false', async () => {
            db.pools = {};
            const result = await db.getReplicaHaltStatus('ZZZ');
            expect(result).to.equal(null);
        });
    });
});

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

describe('Database#getNetwork', () => {
    let db;

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

    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

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
        const expected = require('../../src/coins').resolveConfirmations({}, 'mainnet');
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

    it('filters by name (t2.tick) for a plain ticker search', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('t2.tick=?');
        expect(args).to.deep.equal(['XCHAIN']);
    });

    it('filters by tick_id for a ^id search, and does not truncate it', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: '^1234' } }));
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('t1.tick_id=?');
        expect(queryStr).to.not.include('t2.tick=?');
        expect(args).to.deep.equal([1234]); // NOT 123
    });

    it('returns an object with info, callback, market, lists, locks, mints, supply, projects, registry keys', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // projects/registry resolve to []/null with no baseCoin map (un-inited db).
        // controllers surfaces active controller bindings ([] with no pool/tick id).
        // open_polls lists the token's currently-open governance polls.
        expect(data).to.have.keys(['info', 'callback', 'market', 'lists', 'locks', 'mints', 'supply', 'projects', 'registry', 'controllers', 'open_polls']);
        expect(data.projects).to.deep.equal([]);
        expect(data.registry).to.equal(null);
        expect(data.controllers).to.deep.equal([]);
    });

    it('getTokenOpenPolls selects only open polls for the tick, soonest close first', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const rows = await db.getTokenOpenPolls(cfg({ data: {} }), 'XCHAIN');
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include("m.poll_status='open'");
        expect(queryStr).to.include('pt.tick=?');
        expect(queryStr).to.include('ORDER BY m.end_block ASC');
        expect(queryStr).to.include('m.callback_contract_index');
        expect(args).to.deep.equal(['XCHAIN']);
        expect(rows).to.deep.equal([]);
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
        expect(data.mints.max).to.equal(100);
    });

    it('groups mint_address_max into mints.address_max', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
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
        // LOCK_MAX_SUPPLY=1); callback_decimals stays internal
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
            if(call === 1) return txRow;
            if(call === 2) return actionRows;
            return [];
        });
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

    it('resolves a ^id reference directly to its numeric id, no DB lookup', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTickId(cfg(), '^7')).to.equal(7);
        expect(await db.getTickId(cfg(), '^1234')).to.equal(1234); // NOT truncated to 123
        expect(dq.called).to.equal(false);
    });

    it('falls through to a name lookup when the ^body is non-numeric', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTickId(cfg(), '^abc')).to.be.null;
    });
});

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

describe('Database#getStatus decoder health aggregation', () => {
    const axios = require('axios');
    const ENV_KEYS = ['DECODER_API_URL', 'DECODER_API_URL_BTC_MAINNET', 'DECODER_API_URL_BTC_REGTEST'];
    let db, saved;

    // The per-chain endpoints setupConnectionPools derives from the loaded config
    // (see db.connection.test.js for how they are read out of the config shapes).
    const CONFIG_URLS = { BTC: 'http://decoder-btc-mainnet:3002', RBTC: 'http://decoder-btc-regtest:3002' };
    const healthReply = { data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7 } } };
    // URL each coin's health call was actually POSTed to.
    function urlsByCoin(stub) {
        const seen = {};
        for (const call of stub.getCalls()) seen[call.args[0]] = true;
        return Object.keys(seen);
    }

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

    // A decoder that has never reached its coin node reports the -1 tip sentinel
    // and a negative blockLag; neither is a real height or gap, so both publish
    // as null rather than chain_tip=-1 / chain_lag_blocks=0 ("at the tip").
    it('nulls chain_tip / chain_lag_blocks for the decoder -1 never-polled sentinel', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: -1, blockLag: -900501, lag_blocks: null } }
        });
        const [data] = await db.getStatus(cfg());
        const codes = Object.keys(data.decoder_health);
        expect(codes.length).to.be.greaterThan(0);
        for (const code of codes) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });

    it('prefers the decoder lag_blocks field over blockLag when present', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7, lag_blocks: 7 } }
        });
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    it('treats a negative blockLag from a decoder without lag_blocks as unknown, never 0', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: -1, blockLag: -42 } }
        });
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
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

    // Config-derived endpoints must resolve without a per-chain env var, or the
    // chain->decoder gap goes invisible even on a healthy chain.
    it('polls the per-chain endpoint from the loaded config with no env var set', async () => {
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        const [data] = await db.getStatus(cfg());
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, CONFIG_URLS.RBTC].sort());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    it('lets the coin/network-specific env var override the config-derived endpoint', async () => {
        process.env.DECODER_API_URL_BTC_MAINNET = 'http://override:9002';
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        // BTC takes the override; RBTC still takes its own config-derived endpoint.
        expect(urlsByCoin(post).sort()).to.deep.equal(['http://override:9002', CONFIG_URLS.RBTC].sort());
    });

    it('prefers the per-chain config endpoint over the generic DECODER_API_URL', async () => {
        // The generic var names ONE decoder and is applied to every coin, so on a
        // multi-chain deployment it is right for at most one of them; a per-chain
        // endpoint is right for all of them.
        process.env.DECODER_API_URL = 'http://generic:3001';
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        expect(urlsByCoin(post)).to.not.include('http://generic:3001');
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, CONFIG_URLS.RBTC].sort());
    });

    it('still falls back to the generic DECODER_API_URL for a coin the config has no endpoint for', async () => {
        process.env.DECODER_API_URL = 'http://generic:3001';
        db.decoderApiUrl = { BTC: CONFIG_URLS.BTC };
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, 'http://generic:3001'].sort());
    });
});

// getContract is a single-record data method (returns [data]); it LEFT JOINs
// the contract's permissions manifest.
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

    // openapi's info.description promises chain indices are exact decimal
    // strings on REST, and utility.jsonStringify delivers that only while the value is
    // still the driver's BIGINT. A Number() coercion here collapsed 9007199254740995
    // onto ...96 and disagreed with block_index in this same row.
    it('leaves a BIGINT action_index exact rather than coercing it to a Number', async () => {
        const big = BigInt('9007199254740995');
        sinon.stub(db, 'doQuery').resolves([contractRow({ action_index: big })]);
        const [data] = await db.getContract(baseCfg());
        expect(typeof data.action_index).to.equal('bigint');
        expect(String(data.action_index)).to.equal('9007199254740995');
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
        // Capture only the FIRST query: getContract now issues a second
        // point-read for constructor params after the main select.
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (c, query) => { if(captured === undefined) captured = query; return [contractRow()]; });
        await db.getContract(baseCfg());
        expect(captured).to.include('LEFT  JOIN contract_permissions cp');
        expect(captured).to.include('cp.contract_index=m.action_index');
    });

    it('sets code_hash_ok=true when code_hash matches sha256(code)', async () => {
        const crypto = require('crypto');
        const code   = 'module.exports = { run: function(xchain){ return 1; } };';
        const hash   = crypto.createHash('sha256').update(code).digest('hex');
        sinon.stub(db, 'doQuery').resolves([contractRow({ code, code_hash: hash })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.code_hash_ok).to.equal(true);
    });

    it('flags a corrupted row with code_hash_ok=false', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ code: 'module.exports={}', code_hash: 'not-the-real-hash' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.code_hash_ok).to.equal(false);
    });

    it('extracts the AST method list into `methods`', async () => {
        const code = 'module.exports = { transfer: function(xchain){}, balanceOf: (xchain) => 1 };';
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['balanceOf', 'transfer']);
    });

    it('returns methods=null when the source shape is unrecognized', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code: 'syntax error (', code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.methods).to.equal(null);
    });

    it('surfaces constructor params from the contract_executions constructor row', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
            if(q.includes('contract_executions')){
                expect(q).to.include("method_name='constructor'");
                expect(a[0]).to.equal(900); // the contract's own action_index
                return [{ input_params: 'alice|1000' }];
            }
            return [contractRow()];
        });
        const [data] = await db.getContract(baseCfg());
        expect(data.constructor_params).to.equal('alice|1000');
    });

    it('leaves constructor_params null when the deploy had none', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [{ input_params: '' }] : [contractRow()]);
        const [data] = await db.getContract(baseCfg());
        expect(data.constructor_params).to.equal(null);
    });

    it('keys the introspection cache by the computed digest, not the stored code_hash', async () => {
        // Two rows claim the SAME stored code_hash but carry different code: a
        // corrupted/poisoned row must not seed the cache entry the honest
        // code's digest resolves to (or read it), in either order.
        let code = 'module.exports = { alpha: function(xchain){} };';
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'shared-claimed-hash' })]);
        let [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['alpha']);
        expect(data.code_hash_ok).to.equal(false);
        code = 'module.exports = { beta: function(xchain){} };';
        [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['beta']);
    });

    it('serves the extracted abi block (cached with methods by computed digest)', async () => {
        const code = `module.exports = {
            abi: { version: 1, methods: { run: { summary: 'Run it', params: [ { name: 'x', type: 'string' } ] } } },
            run: function(xchain){}
        };`;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.abi.version).to.equal(1);
        expect(data.abi.methods.run.params).to.deep.equal([{ name: 'x', type: 'string' }]);
        expect(data.methods).to.deep.equal(['run']);
    });

    it('serves abi=null when the contract declares none', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code: 'module.exports = { run: function(x){} };', code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.abi).to.equal(null);
    });

    it('wallet_url defaults, honors an override, and treats empty as explicit off', async () => {
        const prev = process.env.EXPLORER_WALLET_URL;
        try {
            delete process.env.EXPLORER_WALLET_URL;
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            let [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('https://wallet.xchain.io');
            sinon.restore();

            process.env.EXPLORER_WALLET_URL = 'https://wallet.example.test';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('https://wallet.example.test');
            sinon.restore();

            process.env.EXPLORER_WALLET_URL = '';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('');
        } finally {
            if(prev === undefined) delete process.env.EXPLORER_WALLET_URL;
            else process.env.EXPLORER_WALLET_URL = prev;
        }
    });

    it('mirrors the EXPLORER_VM_QUERY_ENABLED flag into vm_query_enabled', async () => {
        const prev = process.env.EXPLORER_VM_QUERY_ENABLED;
        try {
            process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            let [data] = await db.getContract(baseCfg());
            expect(data.vm_query_enabled).to.equal(true);
            sinon.restore();

            process.env.EXPLORER_VM_QUERY_ENABLED = 'false';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.vm_query_enabled).to.equal(false);
        } finally {
            if(prev === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
            else process.env.EXPLORER_VM_QUERY_ENABLED = prev;
        }
    });
});

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

// Controller bindings apply a read-time cooldown reduction, mirroring the
// indexer's readEffectiveControllerMap / controllerEventIfGating.
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

// F3 (id-determinism): the explorer must only surface an index id for SDK ^<id>
// compaction when it is in the DETERMINISTIC set (block_index IS NOT NULL). An
// out-of-band id (recovery pre-seed, pre-F1a) is not reproducible across nodes; the SDK
// must never compact to it (the indexer would reject the ^id). This gates the two
// SDK-facing fields only (getAddress info.address_id, getToken info.tick_id), never the
// internal getAddressId/getTickId resolvers used for display/lookup.
describe('Database F3 id-determinism: only deterministic ids are compaction-exposed', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getCompactableAddressId queries the deterministic set and returns the id', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([{ id: 42 }]);
        const id = await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        expect(id).to.equal(42);
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('block_index IS NOT NULL');
        expect(args).to.deep.equal(['bc1qSrc']);
    });

    it('getCompactableAddressId returns null for a non-deterministic / unindexed address', async () => {
        sinon.stub(db, 'doQuery').resolves([]);   // no row with block_index IS NOT NULL
        expect(await db.getCompactableAddressId(cfg(), 'bc1qOutOfBand')).to.equal(null);
    });

    it('getCompactableAddressId is NOT cached (a NULL-block id must never stick as compactable)', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);
        await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        expect(dq.callCount).to.equal(2);   // re-queried, not served from a cache
    });

    it('getToken gates the SDK-facing tick_id on block_index in the SELECT', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        const [, queryStr] = dq.firstCall.args;
        expect(queryStr).to.match(/CASE WHEN t2\.block_index IS NOT NULL THEN t1\.tick_id ELSE NULL END\) AS tick_id/);
    });

    it('getToken surfaces info.tick_id when the DB returns it (deterministic id)', async () => {
        const row = Object.assign({}, mockResults.tokenRow()[0], { tick_id: 5 });
        sinon.stub(db, 'doQuery').resolves([row]);
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.tick_id).to.equal(5);
    });

    it('getToken surfaces info.tick_id === null when the DB gated it out (non-deterministic id)', async () => {
        // The SELECT CASE returns NULL for a block_index-NULL ticker; model that gated output.
        const row = Object.assign({}, mockResults.tokenRow()[0], { tick_id: null });
        sinon.stub(db, 'doQuery').resolves([row]);
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.tick_id).to.equal(null);
    });
});

describe('Database#getContractFullState', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // doQuery stub serving the aggregate pre-check first, then the row fetch.
    function stubState(aggregates, rows){
        return sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('COUNT(*)') ? [aggregates] : rows);
    }

    it('loads latest state rows into a null-prototype map with JSON fallback', async () => {
        stubState({ total_rows: 2, total_bytes: 20 }, [
            { state_key: 'a',         state_value: '{"x":1}' },
            { state_key: '__proto__', state_value: 'raw-string' }
        ]);
        const state = await db.getContractFullState(cfg(), 900);
        expect(Object.getPrototypeOf(state)).to.equal(null);
        expect(state.a).to.deep.equal({ x: 1 });
        expect(state['__proto__']).to.equal('raw-string');
    });

    it('refuses state over the default row cap BEFORE fetching rows (STATE_TOO_LARGE)', async () => {
        const dq = stubState({ total_rows: 10001, total_bytes: 10 }, []);
        try {
            await db.getContractFullState(cfg(), 900);
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
        expect(dq.callCount).to.equal(1);   // only the aggregate gate ran
    });

    it('refuses state over the byte cap (STATE_TOO_LARGE)', async () => {
        stubState({ total_rows: 1, total_bytes: 4 * 1024 * 1024 + 1 }, []);
        try {
            await db.getContractFullState(cfg(), 900, { maxRows: 10000, maxBytes: 4 * 1024 * 1024 });
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
    });

    it('caps the row fetch with LIMIT as belt-and-braces', async () => {
        const dq = stubState({ total_rows: 1, total_bytes: 5 }, [{ state_key: 'k', state_value: '1' }]);
        await db.getContractFullState(cfg(), 900, { maxRows: 500, maxBytes: 1000 });
        expect(dq.secondCall.args[1]).to.include('LIMIT 500');
    });

    it('re-verifies the byte cap against the FETCHED rows (gate/fetch TOCTOU)', async () => {
        // The aggregate gate approved a small payload, but rows written between
        // the two queries push the actually-fetched set past maxBytes: the
        // loader must throw STATE_TOO_LARGE rather than hand the VM an
        // oversized state object.
        stubState({ total_rows: 2, total_bytes: 10 }, [
            { state_key: 'a', state_value: 'x'.repeat(600) },
            { state_key: 'b', state_value: 'y'.repeat(600) }
        ]);
        try {
            await db.getContractFullState(cfg(), 900, { maxRows: 500, maxBytes: 1000 });
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
    });
});
