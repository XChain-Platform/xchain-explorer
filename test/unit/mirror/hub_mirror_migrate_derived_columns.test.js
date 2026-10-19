'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The additive column list is read from the twin CREATE TABLE files, not hand-kept.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { MIRROR_MIGRATIONS } = require('../../../src/mirror/migrate.js');

describe('hub-mirror-migrate derived columns', function () {
    it('covers every twin table and every column a populated table can gain', function () {
        const { parseDeclaredColumns } = require('../../../src/hub/hub_db_sync/ensure_tables.js');
        const dir = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'hub-mirror');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
        expect(Object.keys(MIRROR_MIGRATIONS).sort()).to.deep.equal(files.map((f) => f.replace(/\.sql$/, '')).sort());
        for (const file of files) {
            const table = file.replace(/\.sql$/, '');
            const addable = parseDeclaredColumns(fs.readFileSync(path.join(dir, file), 'utf8'))
                .filter((c) => !(c.notNull && !c.hasDefault)).map((c) => c.name);
            expect(MIRROR_MIGRATIONS[table].columns.map((c) => c.name), table).to.deep.equal(addable);
        }
    });
    it('flags the hub-stamped columns for a rebuild note', function () {
        const restamped = MIRROR_MIGRATIONS.price_snapshots.columns.filter((c) => c.restamp).map((c) => c.name);
        expect(restamped).to.deep.equal(['batch_block_time', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge']);
    });
});
