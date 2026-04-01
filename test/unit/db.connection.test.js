/**
 * Unit tests for Database connection management functions in src/db.js
 * Covers: constructor, setupConnectionPools, getConnection, releaseConnection
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub, getFullConfig } = require('../fixtures/mock-config.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared mock pool (used for proxyquire — createPool returns this by default)
// ---------------------------------------------------------------------------

let mockMariadb;
let Database;

function freshDatabase(explorerOverrides, configOverrides) {
    const explorer = buildExplorer(configOverrides);
    // Merge any extra explorer props
    if (explorerOverrides) Object.assign(explorer, explorerOverrides);
    return new Database(explorer);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // setupConnectionPools
    // -----------------------------------------------------------------------

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
                    decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Testnet_Decoder' }
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
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            expect(db.pools['BTC'].config.host).to.equal('10.0.0.1');
            expect(db.pools['BTC'].config.port).to.equal(3307);
        });

        it('reuses the same pool object when host/port/user/pass match an existing pool', async function () {
            // The pool-sharing comparison in setupConnectionPools uses cfg.host / cfg.port /
            // cfg.user / cfg.pass (plain keys). Build a config that uses those plain keys so
            // the sharing branch actually fires.
            const config = getFullConfig();
            // Replace db_host/db_port style with plain host/port for both networks
            config.BTC.mainnet.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer'
            };
            config.BTC.regtest.database.indexer = {
                host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer'
            };
            const db = freshDatabase(null, config);
            await db.setupConnectionPools();
            // Only one createPool call should have been made (second key reuses the first pool)
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

    // -----------------------------------------------------------------------
    // getConnection
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // releaseConnection
    // -----------------------------------------------------------------------

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
