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


function releaseConnectionTests() {

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


}

module.exports = { releaseConnectionTests };
