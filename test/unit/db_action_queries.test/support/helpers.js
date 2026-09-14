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
 * Unit tests for all get* ACTION query methods in src/db/index.js
 *
 * Each method is called directly (no DB connection needed) and the returned
 * [query, args, count] triple is verified for:
 *   - correct array length (3 elements)
 *   - presence of the expected main table name in both query and count
 *   - presence of sql.where.data in the WHERE clause
 *   - ORDER BY and LIMIT clauses driven by sql.order / sql.limit
 *   - args value (null for most methods, an array for those that build args internally)
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

// Stubbed MariaDB pool: these tests only build query strings, so no real
// connection is needed.
const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const db = new Database(mockExplorer);

const WHERE_DATA  = 'm.action_index IS NOT NULL AND a2.address=?';
const SEARCH_ADDR = 'addr1';

/**
 * Build a minimal config suitable for most ACTION query methods.
 * sql.where.data is pre-populated so the method can interpolate it directly.
 */
function makeActionConfig(method, type = 'address', overrides = {}) {
    return makeConfig({
        data: {
            method,
            search: SEARCH_ADDR,
            type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: {
                    data:   WHERE_DATA,
                    offset: ''
                }
            },
            ...overrides
        }
    });
}

module.exports = { expect, makeConfig, db, WHERE_DATA, SEARCH_ADDR, makeActionConfig };
