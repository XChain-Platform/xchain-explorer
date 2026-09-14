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


function getConnectionTestsOne() {
    it('returns a connection from the correct pool for the given coin', async function () {
        const mockConn = createMockConnection();
        setMockMariadb({ createPool: sinon.stub().returns(createMockPool(mockConn)) });

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
        setMockMariadb({ createPool: sinon.stub().returns(failingPool) });

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

}


function getConnectionTestsTwo() {
    it('returns transactionConnection immediately if one is already set', async function () {
        const existingConn = createMockConnection();
        const db           = freshDatabase();
        db.transactionConnection = existingConn;

        await db.setupConnectionPools();
        const conn = await db.getConnection({ coin: 'BTC' });

        expect(conn).to.equal(existingConn);
    });


}

module.exports = { getConnectionTestsOne, getConnectionTestsTwo };
