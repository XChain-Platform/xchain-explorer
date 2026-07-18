'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// : additive drift reconciler for the hub-mirror schema. A mirror
// created before the price_snapshots retraction columns landed must get
// them via ensureMirrorColumns() instead of a manual ALTER TABLE, and
// re-running against an up-to-date schema must be a no-op.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = require('../../src/hub-mirror-migrate.js');

// Fake doQuery-bearing connection simulating a price_snapshots table with a
// given set of columns/indexes; records every non-SHOW statement.
function fakeDb({ tables = ['price_snapshots'], columns = [], indexes = [] } = {}) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            if (/^SHOW TABLES LIKE/i.test(sql)) {
                return Promise.resolve(tables.includes(params[0]) ? [{ t: params[0] }] : []);
            }
            if (/^SHOW COLUMNS/i.test(sql)) {
                return Promise.resolve(columns.map((c) => ({ Field: c })));
            }
            if (/^SHOW INDEX/i.test(sql)) {
                return Promise.resolve(indexes.map((i) => ({ Key_name: i })));
            }
            executed.push(sql);
            return Promise.resolve();
        }
    };
}

const LEGACY_COLUMNS = [
    'id', 'round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
    'block_timestamp', 'validator_count', 'consensus_round', 'consensus_proof',
    'status', 'created_at'
];
const CURRENT_COLUMNS = LEGACY_COLUMNS.concat(['source_chain', 'source_action_index', 'push_generation']);
const CURRENT_INDEXES = ['PRIMARY', 'idx_round_pair', 'idx_pair_block', 'idx_pair_timestamp',
    'idx_status', 'idx_source_chain', 'idx_status_block_round'];

const noLog = () => {};

describe('hub-mirror-migrate ', function () {

    it('adds all three retraction columns and the source_chain index to a legacy table', async function () {
        const db = fakeDb({ columns: LEGACY_COLUMNS, indexes: ['PRIMARY', 'idx_round_pair'] });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        const sql = applied[0];
        expect(sql).to.match(/^ALTER TABLE `price_snapshots` /);
        expect(sql).to.include("ADD COLUMN source_chain VARCHAR(10) NOT NULL DEFAULT 'DOGE'");
        expect(sql).to.include('ADD COLUMN source_action_index BIGINT');
        expect(sql).to.include('ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0');
        expect(sql).to.include('ADD KEY idx_source_chain (source_chain)');
        expect(db.executed).to.deep.equal(applied);
    });

    it('is a no-op on an up-to-date schema', async function () {
        const db = fakeDb({ columns: CURRENT_COLUMNS, indexes: CURRENT_INDEXES });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('adds only the missing pieces of a partially-migrated table', async function () {
        // Operator hand-ALTERed source_chain + index but missed the other two.
        const db = fakeDb({
            columns: LEGACY_COLUMNS.concat(['source_chain']),
            indexes: ['PRIMARY', 'idx_source_chain']
        });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        expect(applied[0]).to.not.include('ADD COLUMN source_chain ');
        expect(applied[0]).to.not.include('ADD KEY idx_source_chain');
        expect(applied[0]).to.include('source_action_index');
        expect(applied[0]).to.include('push_generation');
    });

    it('matches column names case-insensitively', async function () {
        const db = fakeDb({ columns: CURRENT_COLUMNS.map((c) => c.toUpperCase()), indexes: CURRENT_INDEXES.map((i) => i.toUpperCase()) });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
    });

    it('skips a table that does not exist (creation is ensureTables\'s job)', async function () {
        const db = fakeDb({ tables: [] });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('migration definitions stay in lockstep with the SQL twin file', function () {
        // Every migrated column/index must appear verbatim-by-name in
        // src/sql/hub-mirror/price_snapshots.sql, so a fresh ensureTables()
        // build and a migrated legacy build converge on the same shape.
        const twin = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror', 'price_snapshots.sql'), 'utf8');
        for (const col of MIRROR_MIGRATIONS.price_snapshots.columns)
            expect(twin, col.name).to.match(new RegExp('^\\s*' + col.name + '\\s', 'm'));
        for (const idx of MIRROR_MIGRATIONS.price_snapshots.indexes)
            expect(twin, idx.name).to.include(idx.name);
    });
});
