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
 * Unit tests for Database connection management functions in src/db/index.js
 * Covers: constructor, setupConnectionPools, getConnection, releaseConnection
 */

'use strict';

const {
    sinon, expect, createConfigInfoStub, getFullConfig, Database, mockMariadb, setMockMariadb,
    createMockConnection, createMockPool, buildExplorer, freshDatabase, hubShapeConfig,
} = require('./helpers.js');


function poolTestsOne() {
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

}


function poolTestsTwo() {
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
        setMockMariadb({ createPool: sinon.stub().onFirstCall().returns(poolA).onSecondCall().returns(poolB) });

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

}


function poolTestsThree() {
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
        setMockMariadb({ createPool: sinon.stub().onFirstCall().returns(poolA).onSecondCall().returns(poolB) });

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


}

module.exports = { poolTestsOne, poolTestsTwo, poolTestsThree };
