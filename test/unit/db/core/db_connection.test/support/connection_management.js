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

const { resetDatabase, restoreStubs } = require('./helpers.js');
const { constructorTests } = require('./constructor.js');
const { cacheTestsOne, cacheTestsTwo } = require('./cache.js');
const { poolTestsOne, poolTestsTwo, poolTestsThree } = require('./pools.js');
const { decoderTestsOne, decoderTestsTwo } = require('./decoder.js');
const { getConnectionTestsOne, getConnectionTestsTwo } = require('./get_connection.js');
const { releaseConnectionTests } = require('./release_connection.js');

describe('Database – connection management', function () {
    // Re-create the mariadb stub and re-require Database each test so
    // createPool call counts are isolated.
    beforeEach(resetDatabase);
    afterEach(restoreStubs);

    describe('constructor', constructorTests);
    describe('_cacheGet / _cacheSet', cacheTestsOne);
    describe('_cacheGet / _cacheSet', cacheTestsTwo);
    describe('setupConnectionPools()', poolTestsOne);
    describe('setupConnectionPools()', poolTestsTwo);
    describe('setupConnectionPools()', poolTestsThree);
    describe('setupConnectionPools() decoder API endpoint', decoderTestsOne);
    describe('setupConnectionPools() decoder API endpoint', decoderTestsTwo);
    describe('getConnection()', getConnectionTestsOne);
    describe('getConnection()', getConnectionTestsTwo);
    describe('releaseConnection()', releaseConnectionTests);
});
