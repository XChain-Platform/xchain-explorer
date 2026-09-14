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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub, getFullConfig } = require('../../fixtures/mock-config.js');

// The pool code lives in src/db/connection.js since proposal B stage 1, and
// db/index.js no longer requires mariadb at all. proxyquire only substitutes a
// module's OWN direct requires, so the driver stub has to be injected into the
// connection module and that module handed to db/index.js; stubbing mariadb on db/index.js
// would silently do nothing and every pool assertion would run against a real
// connection attempt.
function databaseWithDriver(mockMariadb) {
    return proxyquire('../../../src/db/index.js', {
        './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: mockMariadb })
    });
}

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

// Build a minimal explorer-like object that db/index.js expects in its constructor
function buildExplorer(configOverrides) {
    return {
        configInfo: createConfigInfoStub(configOverrides),
        util:       new Utility()
    };
}

// Shared driver stub and Database class, rebuilt before every test; the stub's
// createPool hands back a mock pool by default.
const state = { mockMariadb: null, Database: null };

const mockMariadb = new Proxy({}, {
    get(target, key) { return state.mockMariadb[key]; }
});

const Database = new Proxy(function DatabaseProxy() {}, {
    construct(target, args) { return new state.Database(...args); }
});

function setMockMariadb(driver) {
    state.mockMariadb = driver;
    state.Database = databaseWithDriver(driver);
}

function resetDatabase() {
    setMockMariadb({ createPool: sinon.stub().returns(createMockPool()) });
}

function restoreStubs() {
    sinon.restore();
}

function freshDatabase(explorerOverrides, configOverrides) {
    const explorer = buildExplorer(configOverrides);
    // Merge any extra explorer props
    if (explorerOverrides) Object.assign(explorer, explorerOverrides);
    return new state.Database(explorer);
}

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

module.exports = {
    sinon, expect, createConfigInfoStub, getFullConfig, Database, mockMariadb,
    setMockMariadb, resetDatabase, restoreStubs, createMockConnection, createMockPool,
    buildExplorer, freshDatabase, hubShapeConfig,
};
