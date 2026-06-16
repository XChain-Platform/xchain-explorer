'use strict';

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
 * Smoke tests — Database connectivity (SM-06 through SM-08)
 *
 * Requires MariaDB on port 3307 (start with: npm run test:integration:up).
 * Verifies pool creation, connection success, and bounded failure handling.
 *
 * Run: npm run test:smoke:connected
 */

const { expect }     = require('chai');
const db             = require('../../integration/helpers/db-setup');
const { createApp }  = require('../../integration/helpers/app-setup');

let app, explorer, configInfo;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    ({ app, explorer, configInfo } = await createApp());
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ---------------------------------------------------------------------------
// SM-06: Connection pool initializes
// ---------------------------------------------------------------------------

describe('SM-06: Connection pool initializes', function () {

    it('db.pools contains the RBTC key after init', function () {
        expect(explorer.db.pools).to.have.property('RBTC');
    });

    it('RBTC pool entry has a non-null pool property', function () {
        expect(explorer.db.pools['RBTC']).to.have.property('pool').that.is.not.null;
    });

    it('RBTC pool entry has config with correct database name', function () {
        expect(explorer.db.pools['RBTC']).to.have.property('config');
        expect(explorer.db.pools['RBTC'].config).to.have.property('database', 'XChain_BTC_Regtest_Indexer');
    });

});

// ---------------------------------------------------------------------------
// SM-07: Database connection succeeds
// ---------------------------------------------------------------------------

describe('SM-07: Database connection succeeds', function () {

    it('getConnection() returns a live connection for RBTC', async function () {
        const conn = await Promise.race([
            explorer.db.getConnection({ coin: 'RBTC' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 3s')), 3000))
        ]);

        expect(conn).to.not.be.null;
        // Release immediately
        await explorer.db.releaseConnection();
    });

    it('connection can execute a simple query', async function () {
        const conn = await explorer.db.getConnection({ coin: 'RBTC' });
        expect(conn).to.not.be.null;

        const rows = await conn.query('SELECT 1 AS alive');
        expect(rows).to.be.an('array');
        expect(Number(rows[0].alive)).to.equal(1);

        await explorer.db.releaseConnection();
    });

});

// ---------------------------------------------------------------------------
// SM-08: Database connection failure is bounded
// ---------------------------------------------------------------------------

describe('SM-08: Database connection failure is bounded', function () {

    it('getConnection() returns null for a non-configured coin', async function () {
        const conn = await explorer.db.getConnection({ coin: 'NONEXISTENT' });
        expect(conn).to.be.null;
        // Clean up transactionConnection state
        explorer.db.transactionConnection = null;
    });

    it('getConnection() does not hang on unreachable pool', async function () {
        this.timeout(15000);

        // Temporarily inject a pool pointing to a non-existent port
        const mariadb = require('mariadb');
        const badPool = mariadb.createPool({
            host: '127.0.0.1',
            port: 19999,
            user: 'nobody',
            password: 'nope',
            database: 'nonexistent',
            connectionLimit: 1,
            connectTimeout: 500,
            acquireTimeout: 1000
        });
        const originalPool = explorer.db.pools['RBTC'].pool;
        explorer.db.pools['RBTC'].pool = badPool;

        try {
            const conn = await Promise.race([
                explorer.db.getConnection({ coin: 'RBTC' }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getConnection hung for >12s')), 12000))
            ]);
            // After retries, should return null
            expect(conn).to.be.null;
        } finally {
            // Restore the good pool and clean up
            explorer.db.pools['RBTC'].pool = originalPool;
            explorer.db.transactionConnection = null;
            await badPool.end().catch(() => {});
        }
    });

});
