'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');

const errors = [];
const migrate = proxyquire('../../../src/mirror/migrate.js', {
    '../observability': {
        getLogger: () => ({
            info: () => {},
            error: (...args) => errors.push(args)
        })
    }
});
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = migrate;

const TWIN_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'hub-mirror');
const TABLES = [
    'anchor_reward_attestations',
    'bridge_transfers',
    'capability_snapshots',
    'cross_chain_calls',
    'cross_chain_matches',
    'oracle_prices',
    'policy_snapshots',
    'price_snapshots',
    'state_checkpoints'
];
const PREFIX = "SET STATEMENT time_zone = '+00:00' FOR ALTER TABLE";

function fakeMirrorDb(types, failTable) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            const table = params ? params[0] : (sql.match(/(?:FROM|ALTER TABLE) `([^`]+)`/) || [])[1];
            if (/^SHOW TABLES LIKE/i.test(sql))
                return Promise.resolve(Object.prototype.hasOwnProperty.call(types, table) ? [{ table }] : []);
            if (/^SHOW FULL COLUMNS/i.test(sql)) return Promise.resolve([]);
            if (/^SHOW COLUMNS/i.test(sql)) {
                const spec = MIRROR_MIGRATIONS[table];
                const rows = (spec.columns || []).map((column) => ({ Field: column.name }));
                if (types[table] !== null) rows.push({ Field: 'created_at', Type: types[table] });
                if (table === 'oracle_prices') rows.push({ Field: 'tick', Type: 'varchar(250)' });
                return Promise.resolve(rows);
            }
            if (/^SHOW INDEX/i.test(sql)) {
                const spec = MIRROR_MIGRATIONS[table];
                const rows = (spec.indexes || []).map((index) => ({ Key_name: index.name }));
                for (const index of spec.widenIndexes || [])
                    rows.push({ Key_name: index.name, Column_name: index.requiredColumn });
                return Promise.resolve(rows);
            }
            executed.push(sql);
            if (table === failTable) return Promise.reject(new Error('copy failed'));
            return Promise.resolve();
        }
    };
}

const typeMap = (type) => Object.fromEntries(TABLES.map((table) => [table, type]));
const noLog = () => {};

describe('hub-mirror created_at DATETIME retype', function () {
    it('retypes each legacy TIMESTAMP with one UTC-pinned statement per table', async function () {
        const db = fakeMirrorDb(typeMap('timestamp'));
        const applied = await ensureMirrorColumns(db, noLog);

        expect(applied).to.have.lengthOf(TABLES.length);
        expect(db.executed).to.deep.equal(applied);
        for (const table of TABLES) {
            const statements = applied.filter((sql) => sql.includes('ALTER TABLE `' + table + '`'));
            expect(statements, table).to.have.lengthOf(1);
            expect(statements[0]).to.match(new RegExp('^' + PREFIX.replace(/[+]/g, '\\+') + ' '));
            expect(statements[0]).to.include(MIRROR_MIGRATIONS[table].retypeColumns[0].ddl);
        }
    });

    it('does nothing when all created_at columns are already DATETIME', async function () {
        const db = fakeMirrorDb(typeMap('datetime'));
        expect(await ensureMirrorColumns(db, noLog)).to.deep.equal([]);
        expect(db.executed).to.deep.equal([]);
    });

    it('skips a missing table and a missing created_at column', async function () {
        const types = typeMap('datetime');
        delete types.anchor_reward_attestations;
        types.state_checkpoints = null;
        types.bridge_transfers = 'timestamp';
        const db = fakeMirrorDb(types);

        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        expect(applied[0]).to.include('ALTER TABLE `bridge_transfers`');
    });
});

describe('hub-mirror created_at DATETIME retype safeguards', function () {
    beforeEach(function () {
        errors.length = 0;
    });

    it('logs a failed retype and continues with the other tables', async function () {
        const db = fakeMirrorDb(typeMap('timestamp'), 'cross_chain_calls');
        const applied = await ensureMirrorColumns(db, noLog);

        expect(db.executed).to.have.lengthOf(TABLES.length);
        expect(applied).to.have.lengthOf(TABLES.length - 1);
        expect(errors).to.have.lengthOf(1);
        expect(errors[0][0]).to.equal('HUB_MIRROR_RETYPE_FAILED');
        expect(errors[0][1].run_by_hand).to.equal(db.executed.find(
            (sql) => sql.includes('ALTER TABLE `cross_chain_calls`')));
        expect(applied.some((sql) => sql.includes('ALTER TABLE `state_checkpoints`'))).to.equal(true);
    });

    it('keeps every retype definition equal to its SQL twin', function () {
        for (const table of TABLES) {
            const twin = fs.readFileSync(path.join(TWIN_DIR, table + '.sql'), 'utf8');
            const line = twin.split('\n').find((candidate) => /^\s*created_at\s/i.test(candidate));
            const declared = line.replace(/--.*$/, '').replace(/,\s*$/, '').trim()
                .replace(/^created_at\s+/i, '').replace(/\s+/g, ' ');
            const retype = MIRROR_MIGRATIONS[table].retypeColumns[0];
            const ddl = retype.ddl.replace(/^MODIFY `created_at`\s+/i, '').replace(/\s+/g, ' ');
            expect(ddl, table).to.equal(declared);
            expect(retype).to.include({ name: 'created_at', from: 'timestamp' });
        }
    });
});
