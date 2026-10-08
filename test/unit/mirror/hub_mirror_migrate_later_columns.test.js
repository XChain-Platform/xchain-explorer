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

// Columns the hub gained after the mirror tables first shipped: the admission
// heights, btc_chain_id, batch_block_time and batch_action_index. ensureTables
// gives them to a fresh mirror; an older mirror only ever gains them from
// MIRROR_MIGRATIONS, and without them a current handshake passes against a mirror
// that silently drops those fields and parks the snapshot barrier.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = require('../../../src/mirror/migrate.js');

const LATER_COLUMNS = ['admit_block', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'btc_chain_id', 'batch_block_time', 'batch_action_index'];
const MIRROR_SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'hub-mirror');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Answer SHOW probes from one table's live column list and record every other statement.
function oneTableDb(table, columns) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            if (/^SHOW TABLES LIKE/i.test(sql)) return Promise.resolve(params[0] === table ? [{ t: table }] : []);
            if (/^SHOW FULL COLUMNS/i.test(sql))
                return Promise.resolve(columns.map((c) => ({ Field: c, Collation: 'utf8mb4_general_ci' })));
            if (/^SHOW COLUMNS/i.test(sql)) return Promise.resolve(columns.map((c) => ({ Field: c })));
            if (/^SHOW INDEX/i.test(sql)) return Promise.resolve([{ Key_name: 'PRIMARY', Column_name: 'id' }]);
            executed.push(sql);
            return Promise.resolve();
        }
    };
}

// Every column the table's twin file declares, minus the ones named.
function twinColumnsWithout(table, omit) {
    const twin = fs.readFileSync(path.join(MIRROR_SQL_DIR, table + '.sql'), 'utf8');
    const columns = [];
    for (const line of twin.split('\n')) {
        const m = line.match(/^\s{2,}`?([a-z_]+)`?\s+[A-Z]/);
        if (m && !omit.includes(m[1])) columns.push(m[1]);
    }
    return columns;
}

describe('hub-mirror-migrate later hub columns', function () {
    it('covers every later hub column the twin DDL declares', function () {
        const uncovered = [];
        let pairs = 0;
        for (const file of fs.readdirSync(MIRROR_SQL_DIR).filter((f) => f.endsWith('.sql'))) {
            const table = file.replace(/\.sql$/, '');
            const twin = fs.readFileSync(path.join(MIRROR_SQL_DIR, file), 'utf8');
            for (const col of LATER_COLUMNS) {
                if (!new RegExp('^\\s*' + col + '\\s', 'm').test(twin)) continue;
                pairs++;
                const spec = MIRROR_MIGRATIONS[table];
                if (!spec || !spec.columns.some((c) => c.name === col)) uncovered.push(table + '.' + col);
            }
        }
        expect(pairs, 'the twin scan matched too few later columns').to.be.at.least(20);
        expect(uncovered, 'later columns an older mirror would never gain').to.deep.equal([]);
    });

    it('declares each later column with the exact type its twin file uses', function () {
        let checked = 0;
        for (const table of Object.keys(MIRROR_MIGRATIONS)) {
            const twin = fs.readFileSync(path.join(MIRROR_SQL_DIR, table + '.sql'), 'utf8');
            for (const col of MIRROR_MIGRATIONS[table].columns) {
                if (!LATER_COLUMNS.includes(col.name)) continue;
                const type = col.ddl.replace('ADD COLUMN ' + col.name + ' ', '');
                const line = new RegExp('^\\s*' + col.name + '\\s+' + escapeRe(type) + '\\s*(,|--|$)', 'm');
                expect(twin, table + '.' + col.name + ' as ' + type).to.match(line);
                checked++;
            }
        }
        expect(checked, 'type loop covered nothing').to.be.at.least(20);
    });
});

describe('hub-mirror-migrate later hub columns', function () {
    it('adds the admission and chain identity columns to a cross_chain_matches built before them', async function () {
        const later = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'btc_chain_id'];
        const db = oneTableDb('cross_chain_matches', twinColumnsWithout('cross_chain_matches', later));
        const seen = [];
        const applied = await ensureMirrorColumns(db, (msg) => seen.push(msg));
        expect(applied).to.deep.equal([
            'ALTER TABLE `cross_chain_matches` ADD COLUMN admit_block_btc BIGINT UNSIGNED DEFAULT NULL, '
            + 'ADD COLUMN admit_block_ltc BIGINT UNSIGNED DEFAULT NULL, '
            + 'ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL, '
            + 'ADD COLUMN btc_chain_id CHAR(64)'
        ]);
        expect(db.executed).to.deep.equal(applied);
        expect(seen).to.have.lengthOf(1);
        expect(seen[0]).to.include('keep NULL or 0 in admit_block_btc, admit_block_ltc, admit_block_doge;');
    });

    it('adds the price round batch clock and admission heights to a price_snapshots built before them', async function () {
        const later = ['batch_block_time', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
        const db = oneTableDb('price_snapshots', twinColumnsWithout('price_snapshots', later));
        const applied = await ensureMirrorColumns(db, () => {});
        const add = applied.find((s) => /ADD COLUMN/.test(s));
        expect(add).to.include('ADD COLUMN batch_block_time BIGINT NOT NULL DEFAULT 0');
        expect(add).to.include('ADD COLUMN admit_block_doge BIGINT UNSIGNED DEFAULT NULL');
        expect(add).to.not.include('push_generation');
    });

    it('is a no-op on a table that already carries every twin column', async function () {
        const db = oneTableDb('list_snapshots', twinColumnsWithout('list_snapshots', []));
        const applied = await ensureMirrorColumns(db, () => {});
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('says nothing about a rebuild when only unstamped columns were added', async function () {
        const db = oneTableDb('capability_snapshots', twinColumnsWithout('capability_snapshots', ['btc_chain_id']));
        const seen = [];
        const applied = await ensureMirrorColumns(db, (msg) => seen.push(msg));
        expect(applied.filter((s) => /ADD COLUMN/.test(s)))
            .to.deep.equal(['ALTER TABLE `capability_snapshots` ADD COLUMN btc_chain_id CHAR(64)']);
        expect(seen.join('\n')).to.not.include('rebuild');
    });
});
