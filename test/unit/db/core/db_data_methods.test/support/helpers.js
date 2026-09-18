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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
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
const Utility    = require('../../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../../fixtures/mock-query-args.js');
const mockResults              = require('../../../../../fixtures/mock-db-results.js');

const Database = proxyquire('../../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo    = createConfigInfoStub();
const util          = new Utility(configInfo);
const mockExplorer  = { configInfo, util };

// Every token read probes the connected schema for the ISSUE format 7 bridge columns
// first (bridgeColumnsPresent in src/db/readers/entities/tokens.js). The suites here
// stub doQuery with ONE canned answer for every statement, so that probe would read a
// token row as its column list, conclude the columns are absent, and push the read
// under test down the degraded lane. Seeding the memo states the shape these suites
// are about, a replica that HAS applied the migration, and keeps the probe from
// issuing a query at all, so the first stubbed call is the read itself. The absent
// shape has its own suite: test/unit/db/readers/db_token_bridge_schema_shapes.test.js.
function makeDb() {
    const db = new Database(mockExplorer);
    db.tokenBridgeColumnMemo = { BTC: { present: true, at: Date.now() } };
    return db;
}

function cfg(overrides = {}) {
    return makeConfig({ coin: 'BTC', ...overrides });
}

module.exports = { sinon, expect, configInfo, mockResults, makeDb, cfg };
