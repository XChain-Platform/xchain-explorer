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
const fs     = require('node:fs');
const path   = require('node:path');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');
const mirrorTables = require('../../../src/hub/hub_db_sync/mirror_tables.js');
const { HUB_SCHEMA_VERSION } = require('../../../src/hub/hub_schema_version.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const MIRROR_SQL = path.resolve(__dirname, '../../../src/sql/hub-mirror');
const INDEXER_REMOTE_TOKEN_SQL = path.resolve(
    __dirname, '../../../../xchain-indexer/src/sql/remote_token_snapshots.sql'
);
const INDEXER_REMOTE_TOKEN_VERDICT = siblingCheckout(__dirname, INDEXER_REMOTE_TOKEN_SQL);

function assertRemoteTokenSqlMatchesIndexer() {
    const local = fs.readFileSync(path.join(MIRROR_SQL, 'remote_token_snapshots.sql'));
    const canonical = fs.readFileSync(INDEXER_REMOTE_TOKEN_SQL);

    assert.ok(local.equals(canonical),
        'the vendored remote_token_snapshots SQL differs from xchain-indexer/src/sql');
}

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
        assert.ok(mirrorTables.CROSS_CHAIN_TABLES.includes('list_snapshots'));
    });

    it('ensureTables creates remote_token_snapshots from the vendored directory', async function () {
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
        assert.ok(created.includes('remote_token_snapshots'),
            'ensureTables did not create remote_token_snapshots (created: ' + created.join(', ') + ')');
    });

    it('vendors remote_token_snapshots SQL byte-identical to the indexer copy', function () {
        if (!INDEXER_REMOTE_TOKEN_VERDICT.usable)
            return skipOrFail(this, INDEXER_REMOTE_TOKEN_VERDICT, 'the remote token SQL identity guard');

        assertRemoteTokenSqlMatchesIndexer();
    });

    it('registers remote_token_snapshots for bootstrap, local ids, and retraction', function () {
        assert.ok(mirrorTables.CROSS_CHAIN_TABLES.includes('remote_token_snapshots'));
        assert.ok(mirrorTables.MIRRORED_TABLES.includes('remote_token_snapshots'));
        assert.ok(mirrorTables.AUTO_INCREMENT_ID_TABLES.includes('remote_token_snapshots'));
        assert.equal(mirrorTables.RETRACTION_COLUMNS.remote_token_snapshots, 'source_action_index');
        assert.equal(mirrorTables.RETRACTION_CHAIN_COLUMNS.remote_token_snapshots, 'coin');
        assert.deepEqual(mirrorTables.REFUSED_ROW_NAMES.remote_token_snapshots,
            { column: 'snapshot_id', tag: null });
    });

    it('vendors HUB_SCHEMA_VERSION 9', function () {
        assert.equal(HUB_SCHEMA_VERSION, 9);
    });
});
