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

const assert = require('assert');
const { priceUpsertSql } = require('../../../../src/hub/hub_db_sync/mirror_write.js');
const { mirrorUpsertSql } = require('../../../../src/hub/hub_db_sync/row_upserts.js');

describe('mirror row upsert SQL', function () {
    it('builds an insert-ignore statement with regenerated placeholders', function () {
        const sql = mirrorUpsertSql('sample_rows', ['id', 'name', 'height'], 'unused');

        assert.strictEqual(sql, 'INSERT IGNORE INTO sample_rows (name, height) VALUES (?, ?)');
    });

    it('delegates status-bearing price snapshots to the shared builder', function () {
        const cols = ['id', 'round_number', 'coin_pair', 'status', 'price'];
        const sql = mirrorUpsertSql('price_snapshots', cols, 'unused');

        assert.strictEqual(sql, priceUpsertSql(cols.filter(c => c !== 'id'), 1));
    });

    it('updates oracle content before its generation and never updates its key', function () {
        const cols = ['id', 'source_chain', 'action_index', 'price', 'push_generation'];
        const sql = mirrorUpsertSql('oracle_prices', cols, 'unused');
        const assignments = sql.split(' ON DUPLICATE KEY UPDATE ')[1];

        assert.ok(assignments);
        assert.ok(assignments.endsWith('push_generation = IF(VALUES(`push_generation`) >= `push_generation`, '
            + 'VALUES(`push_generation`), `push_generation`)'));
        assert.ok(!assignments.includes('source_chain'));
        assert.ok(!assignments.includes('action_index'));
    });

    it('gates mutable-table upserts on their marker columns', function () {
        const cases = [
            ['cross_chain_calls', 'status'],
            ['cross_chain_matches', 'anchor_txid'],
            ['attestation_responses', 'batch_action_index']
        ];

        for (const [table, marker] of cases) {
            const withMarker = mirrorUpsertSql(table, ['id', 'natural_key', marker], 'unused');
            const withoutMarker = mirrorUpsertSql(table, ['id', 'natural_key'], 'unused');

            assert.ok(withMarker.includes(' ON DUPLICATE KEY UPDATE '), table);
            assert.strictEqual(withoutMarker, `INSERT IGNORE INTO ${table} (natural_key) VALUES (?)`);
        }
    });
});
