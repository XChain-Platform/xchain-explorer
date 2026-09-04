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

// Additive drift reconciler for the hub-mirror schema. A mirror created
// before the price_snapshots retraction columns landed must get them via
// ensureMirrorColumns() instead of a manual ALTER TABLE, and re-running
// against an up-to-date schema must be a no-op.

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

// Drive the fake connection from a PER-TABLE shape map, so several migrated
// tables can be simulated in one pass (fakeDb above answers every SHOW COLUMNS
// with one shared list). A table absent from the map answers SHOW TABLES empty.
function fakeShapeDb(shapes) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            const table = (sql.match(/FROM `([^`]+)`/) || [])[1];
            if (/^SHOW TABLES LIKE/i.test(sql))
                return Promise.resolve(shapes[params[0]] ? [{ t: params[0] }] : []);
            if (/^SHOW COLUMNS/i.test(sql))
                return Promise.resolve((shapes[table].columns || []).map((c) => ({ Field: c })));
            if (/^SHOW INDEX/i.test(sql))
                return Promise.resolve((shapes[table].indexes || []).map((i) => ({ Key_name: i, Column_name: i })));
            executed.push(sql);
            return Promise.resolve();
        }
    };
}

// Pre-item-5308 shapes of the three twins: every twin column EXCEPT the fence
// columns the reconciler is expected to add back.
const LEGACY_SHAPES = {
    oracle_prices: {
        columns: ['id', 'source_address', 'source_chain', 'coin', 'tick', 'fiat', 'value',
            'fee', 'memo', 'block_time', 'effective_at', 'action_index', 'created_at'],
        indexes: ['PRIMARY', 'idx_oracle_action']
    },
    cross_chain_matches: {
        columns: ['id', 'match_id', 'snapshot_block', 'network', 'a_chain', 'a_action_index',
            'a_amount', 'a_payout_addr', 'b_chain', 'b_action_index', 'b_amount',
            'b_payout_addr', 'effective_time', 'validator_signatures', 'status',
            'batch_root', 'anchor_txid', 'created_at'],
        indexes: ['PRIMARY', 'uq_match_id']
    },
    cross_chain_calls: {
        columns: ['id', 'call_id', 'phase', 'snapshot_block', 'network', 'source_chain',
            'source_action_index', 'source_contract_index', 'target_chain',
            'target_contract_index', 'method', 'params_json', 'gas_limit', 'cross_hops',
            'effective_time', 'status', 'result_status', 'return_payload_b64',
            'validator_signatures', 'created_at'],
        indexes: ['PRIMARY', 'call_phase']
    }
};

// Fence-family columns the twin CREATE TABLE files declare; the guard test at
// the end keeps MIRROR_MIGRATIONS from lagging them again.
const FENCE_COLUMNS = ['push_generation', 'a_push_generation', 'b_push_generation', 'finalizing_view'];

// Mock exposing SHOW INDEX Column_name rows for the capability_snapshots
// uq_cap_snap widen; uqCols is the live column set of uq_cap_snap.
function fakeCapDb(uqCols) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            if (/^SHOW TABLES LIKE/i.test(sql))
                return Promise.resolve(params[0] === 'capability_snapshots' ? [{ t: params[0] }] : []);
            if (/^SHOW COLUMNS/i.test(sql))
                return Promise.resolve(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source'].map((c) => ({ Field: c })));
            if (/^SHOW INDEX/i.test(sql))
                return Promise.resolve([{ Key_name: 'PRIMARY', Column_name: 'id' }].concat(
                    uqCols.map((c) => ({ Key_name: 'uq_cap_snap', Column_name: c }))));
            executed.push(sql);
            return Promise.resolve();
        }
    };
}

const UQ_CAP_ADD = 'ALTER TABLE `capability_snapshots` ADD UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey, source)';

const LEGACY_COLUMNS = [
    'id', 'round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
    'block_timestamp', 'validator_count', 'consensus_round', 'consensus_proof',
    'status', 'created_at'
];
const CURRENT_COLUMNS = LEGACY_COLUMNS.concat(['source_chain', 'source_action_index', 'push_generation']);
const CURRENT_INDEXES = ['PRIMARY', 'idx_round_pair', 'idx_pair_block', 'idx_pair_timestamp',
    'idx_status', 'idx_source_chain', 'idx_status_block_round'];

const noLog = () => {};

describe('hub-mirror-migrate', function () {

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

    it('widens a legacy 3-column uq_cap_snap to include source', async function () {
        const db = fakeCapDb(['snapshot_block', 'capability', 'signing_pubkey']);
        const applied = await ensureMirrorColumns(db, noLog);
        // Drop then re-add the wider key (separate ALTERs so the re-add cannot race).
        expect(db.executed).to.deep.equal([
            'ALTER TABLE `capability_snapshots` DROP INDEX `uq_cap_snap`',
            UQ_CAP_ADD
        ]);
        expect(applied).to.include(UQ_CAP_ADD);
    });

    it('is a no-op when uq_cap_snap already includes source', async function () {
        const db = fakeCapDb(['snapshot_block', 'capability', 'signing_pubkey', 'source']);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('capability_snapshots widen matches the SQL twin uq_cap_snap', function () {
        const twin = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror', 'capability_snapshots.sql'), 'utf8');
        // The widen target column set must be exactly the twin's uq_cap_snap key.
        expect(twin).to.match(/uq_cap_snap\s*\(snapshot_block,\s*capability,\s*signing_pubkey,\s*source\)/);
        expect(MIRROR_MIGRATIONS.capability_snapshots.widenIndexes[0].requiredColumn).to.equal('source');
    });

    it('adds the item-5308 fence columns to a legacy oracle_prices', async function () {
        const db = fakeShapeDb({ oracle_prices: LEGACY_SHAPES.oracle_prices });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.deep.equal([
            'ALTER TABLE `oracle_prices` ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0'
        ]);
        expect(db.executed).to.deep.equal(applied);
    });

    it('adds both legs plus finalizing_view to a legacy cross_chain_matches', async function () {
        // Both legs matter: _applyRetraction ORs a_push_generation and
        // b_push_generation into one DELETE, so either one missing throws.
        const db = fakeShapeDb({ cross_chain_matches: LEGACY_SHAPES.cross_chain_matches });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.deep.equal([
            'ALTER TABLE `cross_chain_matches` ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0, '
            + 'ADD COLUMN a_push_generation BIGINT NOT NULL DEFAULT 0, '
            + 'ADD COLUMN b_push_generation BIGINT NOT NULL DEFAULT 0'
        ]);
    });

    it('adds the fence columns to a legacy cross_chain_calls', async function () {
        const db = fakeShapeDb({ cross_chain_calls: LEGACY_SHAPES.cross_chain_calls });
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.deep.equal([
            'ALTER TABLE `cross_chain_calls` ADD COLUMN finalizing_view INT NOT NULL DEFAULT 0, '
            + 'ADD COLUMN push_generation BIGINT NOT NULL DEFAULT 0'
        ]);
    });

    it('migrates every legacy 5308 twin in one pass, one ALTER each', async function () {
        const db = fakeShapeDb(LEGACY_SHAPES);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(3);
        expect(applied.map((s) => s.match(/^ALTER TABLE `([^`]+)`/)[1]).sort())
            .to.deep.equal(['cross_chain_calls', 'cross_chain_matches', 'oracle_prices']);
    });

    it('is a no-op once the 5308 twins already carry their fence columns', async function () {
        const shapes = {};
        for (const t of Object.keys(LEGACY_SHAPES)) {
            shapes[t] = {
                columns: LEGACY_SHAPES[t].columns.concat(
                    MIRROR_MIGRATIONS[t].columns.map((c) => c.name)),
                indexes: LEGACY_SHAPES[t].indexes
            };
        }
        const db = fakeShapeDb(shapes);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('migration definitions stay in lockstep with the SQL twin files', function () {
        // Require every migrated column/index verbatim-by-name in its own twin, so
        // a fresh build and a migrated legacy one converge on the same shape.
        // Loop every key, not price_snapshots alone: a new entry cannot enter
        // unchecked, which is how the three fence tables were missed.
        let checked = 0;
        for (const table of Object.keys(MIRROR_MIGRATIONS)) {
            const twin = fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror', table + '.sql'), 'utf8');
            for (const col of MIRROR_MIGRATIONS[table].columns) {
                expect(twin, table + '.' + col.name).to.match(new RegExp('^\\s*' + col.name + '\\s', 'm'));
                checked++;
            }
            for (const idx of MIRROR_MIGRATIONS[table].indexes || []) {
                expect(twin, table + '.' + idx.name).to.include(idx.name);
                checked++;
            }
        }
        // Assert the census: capability_snapshots migrates only an index widen, so
        // the loop passes vacuously on it and an empty loop would look identical.
        expect(checked, 'lockstep loop covered nothing').to.be.at.least(10);
    });

    it('every fence column the twin DDL declares is covered by MIRROR_MIGRATIONS', function () {
        // The list has lagged the twin files before. Scan the twins for the
        // fence-column family and fail on any (table, column) pair with no entry.
        const dir = path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror');
        const uncovered = [];
        let pairs = 0;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
            const table = file.replace(/\.sql$/, '');
            const twin = fs.readFileSync(path.join(dir, file), 'utf8');
            for (const col of FENCE_COLUMNS) {
                if (!new RegExp('^\\s*' + col + '\\s', 'm').test(twin)) continue;
                pairs++;
                const spec = MIRROR_MIGRATIONS[table];
                if (!spec || !spec.columns.some((c) => c.name === col)) uncovered.push(table + '.' + col);
            }
        }
        expect(pairs, 'the twin scan matched no fence column at all').to.be.at.least(7);
        expect(uncovered, 'fence columns a legacy mirror would never gain').to.deep.equal([]);
    });
});
