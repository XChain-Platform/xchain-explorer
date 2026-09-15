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


function constructorTests() {

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


}

module.exports = { constructorTests };
