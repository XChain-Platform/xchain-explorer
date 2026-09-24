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

// oracle_prices.tick length widen in the hub-mirror reconciler. An existing
// mirror keeps the VARCHAR(50) it was created with (ensureTables never ALTERs),
// so the reconciler is what brings it to the 250 PRICE v1 admits before the hub
// is allowed to store a longer tick.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = require('../../../src/mirror/migrate.js');

const TWIN = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'hub-mirror', 'oracle_prices.sql');
const WIDEN = 'ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL';
const COLUMNS = ['id', 'source_address', 'source_chain', 'coin', 'tick', 'fiat', 'value', 'fee',
    'memo', 'block_time', 'effective_at', 'action_index', 'push_generation', 'admit_block', 'created_at'];

// A mirror holding only oracle_prices, whose tick reports `tickType` ('' = no Type served).
function fakeOracleDb(tickType, failAlter) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            if (/^SHOW TABLES LIKE/i.test(sql))
                return Promise.resolve(params[0] === 'oracle_prices' ? [{ t: params[0] }] : []);
            if (/^SHOW COLUMNS/i.test(sql))
                return Promise.resolve(COLUMNS.map((c) => (c === 'tick' && tickType ? { Field: c, Type: tickType } : { Field: c })));
            if (/^SHOW INDEX/i.test(sql)) return Promise.resolve([]);
            executed.push(sql);
            return failAlter ? Promise.reject(new Error('errno 1071')) : Promise.resolve();
        }
    };
}

const noLog = () => {};

describe('hub-mirror-migrate oracle_prices.tick widen', function () {
    it('widens a legacy varchar(50) tick to the twin width', async function () {
        const db = fakeOracleDb('varchar(50)');
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.deep.equal([WIDEN]);
        expect(db.executed).to.deep.equal([WIDEN]);
    });

    it('is a no-op once tick is already 250', async function () {
        const db = fakeOracleDb('varchar(250)');
        expect(await ensureMirrorColumns(db, noLog)).to.deep.equal([]);
        expect(db.executed).to.deep.equal([]);
    });

    it('never guesses when the live Type is not served', async function () {
        const db = fakeOracleDb('');
        expect(await ensureMirrorColumns(db, noLog)).to.deep.equal([]);
    });

    it('logs a failed widen instead of keeping the mirror from starting', async function () {
        const db = fakeOracleDb('varchar(50)', true);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(db.executed).to.deep.equal([WIDEN]);
        expect(applied).to.deep.equal([]);
    });

    it('restates the twin definition, so fresh and migrated mirrors converge', function () {
        const line = fs.readFileSync(TWIN, 'utf8').split('\n').find((l) => /^\s*tick\s/.test(l));
        const declared = line.replace(/--.*$/, '').replace(/,\s*$/, '').trim().replace(/^tick\s+/, '').replace(/\s+/g, ' ');
        const spec = MIRROR_MIGRATIONS.oracle_prices.widenLengths[0];
        expect(spec.ddl).to.equal('MODIFY `tick` ' + declared);
        expect(declared).to.equal('VARCHAR(' + spec.length + ') NOT NULL');
    });
});
