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
 * Unit tests for Database connection management functions in src/db.js
 * Covers: constructor, setupConnectionPools, getConnection, releaseConnection
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub, getFullConfig } = require('../fixtures/mock-config.js');

function createMockConnection() {
    return {
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    };
}

function createMockPool(mockConn) {
    return {
        getConnection: sinon.stub().resolves(mockConn || createMockConnection())
    };
}

// Build a minimal explorer-like object that db.js expects in its constructor
function buildExplorer(configOverrides) {
    return {
        configInfo: createConfigInfoStub(configOverrides),
        util:       new Utility()
    };
}

let mockMariadb;
let Database;

function freshDatabase(explorerOverrides, configOverrides) {
    const explorer = buildExplorer(configOverrides);
    // Merge any extra explorer props
    if (explorerOverrides) Object.assign(explorer, explorerOverrides);
    return new Database(explorer);
}

describe('Database – connection management', function () {

    beforeEach(function () {
        // Re-create the mariadb stub and re-require Database each test so
        // createPool call counts are isolated.
        mockMariadb = { createPool: sinon.stub().returns(createMockPool()) };
        Database    = proxyquire('../../src/db.js', { mariadb: mockMariadb });
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {

        it('sets configInfo alias from explorer', function () {
            const explorer = buildExplorer();
            const db = new Database(explorer);
            expect(db.configInfo).to.equal(explorer.configInfo);
        });

        it('sets util alias from explorer', function () {
            const explorer = buildExplorer();
            const db = new Database(explorer);
            expect(db.util).to.equal(explorer.util);
        });

        it('registers an onConfigChanged listener', function () {
            const explorer = buildExplorer();
            const db = new Database(explorer);
            // The fixture tracks listeners via _listeners
            expect(explorer.configInfo._listeners).to.have.lengthOf(1);
        });

        it('actionTables contains core expected table names', function () {
            const db = freshDatabase();
            const expected = [
                'addresses', 'issues', 'sends', 'orders', 'order_matches',
                'dispensers', 'dispenses', 'sweeps'
            ];
            for (const table of expected) {
                expect(db.actionTables).to.include(table);
            }
        });

        it('initialises transactionConnection to null', function () {
            const db = freshDatabase();
            expect(db.transactionConnection).to.be.null;
        });

    });

    describe('_cacheGet / _cacheSet', function () {

        it('_cacheGet returns undefined for missing key', function () {
            const db = freshDatabase();
            const cache = new Map();
            expect(db._cacheGet(cache, 'missing')).to.be.undefined;
        });

        it('_cacheSet and _cacheGet round-trip a value', function () {
            const db = freshDatabase();
            const cache = new Map();
            db._cacheSet(cache, 'key1', 'value1');
            expect(db._cacheGet(cache, 'key1')).to.equal('value1');
        });

        it('_cacheGet promotes key to most-recent (LRU behavior)', function () {
            const db = freshDatabase();
            const cache = new Map();
            db._cacheSet(cache, 'a', 1, 3);
            db._cacheSet(cache, 'b', 2, 3);
            db._cacheSet(cache, 'c', 3, 3);
            // Access 'a' to promote it
            db._cacheGet(cache, 'a');
            // Add a 4th entry, which should evict the LRU key ('b')
            db._cacheSet(cache, 'd', 4, 3);
            expect(db._cacheGet(cache, 'b')).to.be.undefined;
            expect(db._cacheGet(cache, 'a')).to.equal(1);
        });

        it('_cacheSet evicts oldest entry when maxSize exceeded', function () {
            const db = freshDatabase();
            const cache = new Map();
            db._cacheSet(cache, 'a', 1, 2);
            db._cacheSet(cache, 'b', 2, 2);
            // Adding 'c' should evict 'a'
            db._cacheSet(cache, 'c', 3, 2);
            expect(cache.size).to.equal(2);
            expect(db._cacheGet(cache, 'a')).to.be.undefined;
            expect(db._cacheGet(cache, 'b')).to.equal(2);
            expect(db._cacheGet(cache, 'c')).to.equal(3);
        });

        it('_cacheSet overwrites existing key without increasing size', function () {
            const db = freshDatabase();
            const cache = new Map();
            db._cacheSet(cache, 'a', 1, 2);
            db._cacheSet(cache, 'a', 99, 2);
            expect(cache.size).to.equal(1);
            expect(db._cacheGet(cache, 'a')).to.equal(99);
        });

        it('_cacheGet returns correct value (not just truthy)', function () {
            const db = freshDatabase();
            const cache = new Map();
            db._cacheSet(cache, 'zero', 0);
            db._cacheSet(cache, 'false', false);
            db._cacheSet(cache, 'empty', '');
            expect(db._cacheGet(cache, 'zero')).to.equal(0);
            expect(db._cacheGet(cache, 'false')).to.equal(false);
            expect(db._cacheGet(cache, 'empty')).to.equal('');
        });

    });

    describe('setupConnectionPools()', function () {

        it('creates a pool entry keyed "BTC" for BTC mainnet', async function () {
            const db = freshDatabase();
            await db.setupConnectionPools();
            expect(db.pools).to.have.property('BTC');
        });

        it('creates a pool entry keyed "RBTC" for BTC regtest', async function () {
            const db = freshDatabase();
            await db.setupConnectionPools();
            expect(db.pools).to.have.property('RBTC');
        });

        it('creates a pool entry keyed "TBTC" for BTC testnet', async function () {
            // Build a config that includes a testnet block
            const config = getFullConfig();
            config.BTC.testnet = {
                database: {
                    indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Testnet_Indexer' },
                    decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Testnet_Decoder' },
                    // Mandatory co-located hub DB: a serving coin must declare it
                    // or setupConnectionPools throws the startup assertion.
                    checkpoint: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_Hub' }
                }
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.pools).to.have.property('TBTC');
        });

        it('pool config uses correct host / port / user / password / database', async function () {
            const db = freshDatabase();
            await db.setupConnectionPools();
            const cfg = db.pools['BTC'].config;
            expect(cfg.host).to.equal('127.0.0.1');
            expect(cfg.port).to.equal(3306);
            expect(cfg.user).to.equal('root');
            expect(cfg.password).to.equal('pass');
            expect(cfg.database).to.equal('XChain_BTC_Mainnet_Indexer');
        });

        it('remaps host/port to db_host/db_port when only host/port are present', async function () {
            const config = getFullConfig();
            // Replace db_host/db_port style keys with plain host/port
            config.BTC.mainnet.database.indexer = {
                host: '10.0.0.1', port: 3307, user: 'admin', pass: 'secret', name: 'XChain_BTC_Mainnet_Indexer'
            };
            // Keep the mandatory co-located hub DB on the SAME host/creds as the
            // relocated indexer so the startup assertion is satisfied.
            config.BTC.mainnet.database.checkpoint = {
                host: '10.0.0.1', port: 3307, user: 'admin', pass: 'secret', name: 'XChain_Hub'
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.pools['BTC'].config.host).to.equal('10.0.0.1');
            expect(db.pools['BTC'].config.port).to.equal(3307);
        });

        it('does NOT share a pool across different databases even when host/port/user/pass match', async function () {
            // Regression: a MariaDB pool is pinned to one default database, and the explorer
            // runs unqualified queries (FROM blocks) against it. Sharing one pool across coins
            // that differ only by database name made every coin query the first pool's DB.
            // e.g. all coins served BTC data on the single-server NO_HUB deployment where every
            // coin uses one MariaDB user. Same creds + different DB must yield SEPARATE pools.
            const config = getFullConfig();
            config.BTC.mainnet.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer'
            };
            config.BTC.regtest.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer'
            };
            const poolA = createMockPool();
            const poolB = createMockPool();
            mockMariadb = { createPool: sinon.stub().onFirstCall().returns(poolA).onSecondCall().returns(poolB) };
            Database    = proxyquire('../../src/db.js', { mariadb: mockMariadb });

            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(mockMariadb.createPool.callCount).to.equal(2);
            expect(db.pools['BTC'].pool).to.not.equal(db.pools['RBTC'].pool);
            expect(db.pools['BTC'].config.database).to.equal('XChain_BTC_Mainnet_Indexer');
            expect(db.pools['RBTC'].config.database).to.equal('XChain_BTC_Regtest_Indexer');
        });

        it('reuses the same pool only when host/port/user/pass AND database all match', async function () {
            // The sharing optimization is preserved for the (safe) case where two config
            // entries point at the exact same database (same default DB), so one pool is fine.
            const config = getFullConfig();
            config.BTC.mainnet.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_Shared_Indexer'
            };
            config.BTC.regtest.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_Shared_Indexer'
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(mockMariadb.createPool.callCount).to.equal(1);
            expect(db.pools['BTC'].pool).to.equal(db.pools['RBTC'].pool);
        });

        it('calls mariadb.createPool with a new pool when connection details differ', async function () {
            const config = getFullConfig();
            // Use plain host/port so the sharing comparison runs, but give regtest a
            // different host so it cannot reuse the mainnet pool.
            config.BTC.mainnet.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer'
            };
            config.BTC.regtest.database.indexer = {
                host: '10.9.9.9', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer'
            };
            // Keep the regtest decoder on the SAME host/creds as its indexer so it
            // reuses that pool; this test isolates INDEXER pool separation by host.
            // (A decoder on a different host/creds than its indexer correctly spawns
            // its own dedicated pool; that path is exercised elsewhere. Leaving the
            // default 127.0.0.1 decoder here would mismatch the 10.9.9.9 indexer and
            // add a third, unrelated createPool call.)
            config.BTC.regtest.database.decoder = {
                host: '10.9.9.9', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Decoder'
            };
            // Keep the mandatory co-located hub DB on the SAME host/creds as the relocated
            // regtest indexer so the startup assertion is satisfied. It reuses the
            // indexer pool (same host/creds), so it does NOT add a createPool call.
            config.BTC.regtest.database.checkpoint = {
                host: '10.9.9.9', port: 3306, user: 'root', pass: 'pass', name: 'XChain_Hub'
            };
            // Make createPool return distinct objects so the inequality check is meaningful
            const poolA = createMockPool();
            const poolB = createMockPool();
            mockMariadb = { createPool: sinon.stub().onFirstCall().returns(poolA).onSecondCall().returns(poolB) };
            Database    = proxyquire('../../src/db.js', { mariadb: mockMariadb });

            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(mockMariadb.createPool.callCount).to.equal(2);
            expect(db.pools['BTC'].pool).to.not.equal(db.pools['RBTC'].pool);
        });

        it('resets pools to empty object on each call', async function () {
            const db = freshDatabase();
            await db.setupConnectionPools();
            const firstPools = db.pools;
            await db.setupConnectionPools();
            // pools object should be a fresh reference
            expect(db.pools).to.not.equal(firstPools);
        });

    });

    // The decoder JSON-RPC endpoint /api/status polls for chain_tip /
    // chain_lag_blocks / decoder_health. Deriving it from the config the explorer
    // already loads is what stops every coin reading 'unconfigured' on a
    // deployment that never exported one DECODER_API_URL_<COIN>_<NETWORK> per
    // chain.
    describe('setupConnectionPools() decoder API endpoint', function () {

        // Hub-config shape: xchain-node's updateconfig push carries db_host/db_port
        // for the decoder DATABASE and host/port for the decoder's API port.
        function hubShapeConfig() {
            const config = getFullConfig();
            config.BTC.mainnet.database.decoder = {
                host: 'xchain-decoder-btc-mainnet', port: 3002,
                db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass',
                name: 'XChain_BTC_Mainnet_Decoder'
            };
            return config;
        }

        it('derives the endpoint from the hub-config host/port pair', async function () {
            const db = freshDatabase(null, hubShapeConfig());
            await db.setupConnectionPools();
            expect(db.decoderApiUrl['BTC']).to.equal('http://xchain-decoder-btc-mainnet:3002');
        });

        it('does NOT read a config.json decoder DB (host/port, no db_host) as an endpoint', async function () {
            // In config.json, host/port ARE the database, so treating them as an API
            // endpoint would point the health poll at MariaDB. Absent beats wrong:
            // the coin reports 'unconfigured' rather than a permanent 'unreachable'.
            const config = getFullConfig();
            config.BTC.mainnet.database.decoder = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass',
                name: 'XChain_BTC_Mainnet_Decoder'
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.decoderApiUrl).to.not.have.property('BTC');
        });

        it('honors an explicit api_url over the host/port pair', async function () {
            const config = hubShapeConfig();
            config.BTC.mainnet.database.decoder.api_url = 'http://decoder.internal:4002/';
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            // Trailing slash trimmed: the connector POSTs to the URL as given.
            expect(db.decoderApiUrl['BTC']).to.equal('http://decoder.internal:4002');
        });

        it('honors an explicit api_host + api_port in the config.json shape', async function () {
            // The one-line way a config.json deployment (no hub) can wire the
            // endpoint beside the DB instead of exporting an env var per chain.
            const config = getFullConfig();
            config.BTC.mainnet.database.decoder = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass',
                name: 'XChain_BTC_Mainnet_Decoder',
                api_host: '10.0.0.7', api_port: 3002
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.decoderApiUrl['BTC']).to.equal('http://10.0.0.7:3002');
        });

        it('does not double-prefix a host that already carries a scheme', async function () {
            const config = hubShapeConfig();
            config.BTC.mainnet.database.decoder.host = 'https://decoder.example.com';
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.decoderApiUrl['BTC']).to.equal('https://decoder.example.com:3002');
        });

        it('records no endpoint for a coin whose decoder entry carries none', async function () {
            // getFullConfig's decoder entries are DB-only (db_host/db_port, no
            // host/port), which is the pre-existing 'unconfigured' case.
            const db = freshDatabase();
            await db.setupConnectionPools();
            expect(db.decoderApiUrl).to.deep.equal({});
        });

        it('resets the endpoint map on each call so a removed endpoint stops being polled', async function () {
            const db = freshDatabase(null, hubShapeConfig());
            await db.setupConnectionPools();
            expect(db.decoderApiUrl['BTC']).to.be.a('string');
            // Re-enter with a config that no longer names an endpoint.
            db.configInfo = createConfigInfoStub(getFullConfig());
            await db.setupConnectionPools();
            expect(db.decoderApiUrl).to.not.have.property('BTC');
        });

    });

    describe('getConnection()', function () {

        it('returns a connection from the correct pool for the given coin', async function () {
            const mockConn = createMockConnection();
            mockMariadb    = { createPool: sinon.stub().returns(createMockPool(mockConn)) };
            Database       = proxyquire('../../src/db.js', { mariadb: mockMariadb });

            const db = freshDatabase();
            await db.setupConnectionPools();
            const conn = await db.getConnection({ coin: 'BTC' });
            expect(conn).to.equal(mockConn);
        });

        it('returns null when no pool exists for the coin', async function () {
            const db = freshDatabase();
            await db.setupConnectionPools();
            const conn = await db.getConnection({ coin: 'XYZ' });
            expect(conn).to.be.null;
        });

        it('retries up to 3 times on repeated connection failure then returns null', async function () {
            // Pool whose getConnection always rejects
            const failingPool = { getConnection: sinon.stub().rejects(new Error('timeout')) };
            mockMariadb       = { createPool: sinon.stub().returns(failingPool) };
            Database          = proxyquire('../../src/db.js', { mariadb: mockMariadb });

            const db        = freshDatabase();
            const sleepStub = sinon.stub(db.util, 'sleep').resolves();

            await db.setupConnectionPools();
            const conn = await db.getConnection({ coin: 'BTC' });

            expect(conn).to.be.null;
            // Loop condition is retryCount <= maxRetrys (3), so it sleeps on attempts
            // 0→1, 1→2, 2→3, 3→4, then breaks when retryCount (4) > maxRetrys (3).
            // That is 4 sleep calls total.
            expect(sleepStub.callCount).to.equal(4);
            expect(sleepStub.alwaysCalledWith(1000)).to.be.true;
        });

        it('resolves immediately on success without calling sleep', async function () {
            const db        = freshDatabase();
            const sleepStub = sinon.stub(db.util, 'sleep').resolves();

            await db.setupConnectionPools();
            await db.getConnection({ coin: 'BTC' });

            expect(sleepStub.callCount).to.equal(0);
        });

        it('returns transactionConnection immediately if one is already set', async function () {
            const existingConn = createMockConnection();
            const db           = freshDatabase();
            db.transactionConnection = existingConn;

            await db.setupConnectionPools();
            const conn = await db.getConnection({ coin: 'BTC' });

            expect(conn).to.equal(existingConn);
        });

    });

    describe('releaseConnection()', function () {

        it('calls release() on the active connection and sets transactionConnection to null', async function () {
            const mockConn = createMockConnection();
            const db       = freshDatabase();
            db.transactionConnection = mockConn;

            await db.releaseConnection();

            expect(mockConn.release.calledOnce).to.be.true;
            expect(db.transactionConnection).to.be.null;
        });

        it('does nothing when transactionConnection is already null', async function () {
            const db = freshDatabase();
            // Should not throw and transactionConnection should remain null
            await db.releaseConnection();
            expect(db.transactionConnection).to.be.null;
        });

    });

});
