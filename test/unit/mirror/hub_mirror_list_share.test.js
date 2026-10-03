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
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const path   = require('node:path');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');
const { CROSS_CHAIN_TABLES } = require('../../../src/hub/hub_db_sync/mirror_tables.js');
const { HUB_SCHEMA_VERSION } = require('../../../src/hub/hub_schema_version.js');

const MIRROR_SQL = path.resolve(__dirname, '../../../src/sql/hub-mirror');

describe('hub-mirror list share vendored contract @regression', function () {
    it('ensureTables creates list_snapshots from the vendored directory', async function () {
        const created = [];
        const conn = {
            async doQuery(sql) {
                if (/^SHOW TABLES LIKE/i.test(sql.trim())) return [];
                const match = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i.exec(sql);
                if (match) created.push(match[1]);
                return [];
            }
        };

        await HubDbSync.ensureTables(conn, MIRROR_SQL);
        assert.ok(created.includes('list_snapshots'),
            'ensureTables did not create list_snapshots (created: ' + created.join(', ') + ')');
    });

    it('includes list_snapshots in CROSS_CHAIN_TABLES', function () {
        assert.ok(CROSS_CHAIN_TABLES.includes('list_snapshots'));
    });

    it('vendors HUB_SCHEMA_VERSION 9', function () {
        assert.equal(HUB_SCHEMA_VERSION, 9);
    });
});
