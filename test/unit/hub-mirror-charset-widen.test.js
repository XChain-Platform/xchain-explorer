'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The charset-widen leg of the hub-mirror reconciler.
//
// attestation_responses carries the finalized ATTEST response, and its
// response_payload / meta hold provider bytes whose on-chain counterparts are
// utf8mb4. A mirror schema still on the table's utf8mb3 tail refuses a body with a
// 4-byte character (errno 1366 under STRICT_TRANS_TABLES); the table re-pages from
// cursor 0, so that row is re-delivered and re-refused on every drain. ensureTables
// only CREATEs a missing table, so an existing mirror is reached by nothing but this
// widen.

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = require('../../src/hub-mirror-migrate.js');

const TWIN_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror');
const noLog = () => {};

// A doQuery-bearing connection over a per-table shape map that also answers
// SHOW FULL COLUMNS, whose `Collation` is the only place the live charset shows up.
// `collations` maps a column name to its live collation; a column absent from it
// reports no collation at all (a non-string column, as MariaDB reports it).
function fakeCharsetDb(shapes) {
    const executed = [];
    return {
        executed,
        doQuery(sql, params) {
            const table = (sql.match(/FROM `([^`]+)`/) || [])[1];
            if (/^SHOW TABLES LIKE/i.test(sql))
                return Promise.resolve(shapes[params[0]] ? [{ t: params[0] }] : []);
            if (/^SHOW FULL COLUMNS/i.test(sql))
                return Promise.resolve(Object.keys(shapes[table].collations || {}).map(
                    (c) => ({ Field: c, Collation: shapes[table].collations[c] })));
            if (/^SHOW COLUMNS/i.test(sql))
                return Promise.resolve((shapes[table].columns || []).map((c) => ({ Field: c })));
            // SHOW INDEX answers one row per key COLUMN. The unique key on this table
            // is (network, request_id, effective_time) and the migration widens any
            // narrower live key, so a fake that answered the key's name as its only
            // column would make every charset case fail on an unexpected key rebuild.
            if (/^SHOW INDEX/i.test(sql))
                return Promise.resolve((shapes[table].indexes || []).flatMap((i) => i === 'uq_attest_response'
                    ? ['network', 'request_id', 'effective_time'].map((c) => ({ Key_name: i, Column_name: c }))
                    : [{ Key_name: i, Column_name: i }]));
            executed.push(sql);
            return Promise.resolve();
        }
    };
}

const COLUMNS = ['id', 'network', 'request_id', 'provider_id', 'status', 'response_payload',
                 'response_hash', 'meta', 'effective_time', 'signer_pubkeys', 'signatures'];

// A mirror predating the widen: both provider-byte columns on the utf8mb3 tail.
const LEGACY = {
    attestation_responses: {
        columns: COLUMNS,
        indexes: ['PRIMARY', 'uq_attest_response'],
        collations: { response_payload: 'utf8mb3_general_ci', meta: 'utf8mb3_general_ci',
                      signer_pubkeys: 'utf8mb3_general_ci' }
    }
};

const shapeWith = (collations) => ({
    attestation_responses: Object.assign({}, LEGACY.attestation_responses, { collations })
});

describe('hub-mirror charset widen (attestation_responses)', function () {

    it('widens both provider-byte columns on a legacy mirror, in one ALTER', async function () {
        const db = fakeCharsetDb(LEGACY);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        const sql = applied[0];
        expect(sql).to.match(/^ALTER TABLE `attestation_responses` /);
        expect(sql).to.include('MODIFY `response_payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        expect(sql).to.include('MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        expect(db.executed).to.deep.equal(applied);
    });

    it('leaves a column that carries no provider bytes alone', async function () {
        const db = fakeCharsetDb(LEGACY);
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied[0]).to.not.include('signer_pubkeys');
    });

    it('is a no-op once both columns are already utf8mb4', async function () {
        const db = fakeCharsetDb(shapeWith({ response_payload: 'utf8mb4_general_ci',
                                             meta: 'utf8mb4_general_ci',
                                             signer_pubkeys: 'utf8mb3_general_ci' }));
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
        expect(db.executed).to.have.lengthOf(0);
    });

    it('widens only the half that is still narrow on a partially-migrated mirror', async function () {
        const db = fakeCharsetDb(shapeWith({ response_payload: 'utf8mb4_general_ci',
                                             meta: 'utf8mb3_general_ci' }));
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        expect(applied[0]).to.include('MODIFY `meta`');
        expect(applied[0]).to.not.include('MODIFY `response_payload`');
    });

    it('skips a column the live mirror does not carry (ensureTables owns creation)', async function () {
        const db = fakeCharsetDb(shapeWith({ response_payload: 'utf8mb3_general_ci' }));
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(1);
        expect(applied[0]).to.include('MODIFY `response_payload`');
        expect(applied[0]).to.not.include('MODIFY `meta`');
    });

    it('skips a table that does not exist at all', async function () {
        const db = fakeCharsetDb({});
        const applied = await ensureMirrorColumns(db, noLog);
        expect(applied).to.have.lengthOf(0);
    });

    // A widen that converged on a shape the twin file does not declare would leave a
    // migrated mirror and a fresh one holding different columns, which is the whole
    // failure this reconciler exists to prevent.
    it('every widen states the charset its SQL twin declares', function () {
        let checked = 0;
        for (const table of Object.keys(MIRROR_MIGRATIONS)) {
            const spec = MIRROR_MIGRATIONS[table];
            if (!spec.widenColumns || spec.widenColumns.length === 0) continue;
            const twin = fs.readFileSync(path.join(TWIN_DIR, table + '.sql'), 'utf8');
            for (const w of spec.widenColumns) {
                const line = twin.split('\n').find(
                    (l) => new RegExp('^\\s*`?' + w.name + '`?\\s+[A-Z]', 'i').test(l));
                expect(line, table + '.' + w.name + ' is not declared in its twin').to.exist;
                const declared = /CHARACTER\s+SET\s+(\w+)/i.exec(line.replace(/--.*$/, ''));
                expect(declared, table + '.' + w.name + ' declares no charset in its twin').to.exist;
                expect(declared[1].toLowerCase()).to.equal(String(w.charset).toLowerCase());
                // The MODIFY must restate the twin's own type, or the two paths diverge.
                const type = line.replace(/--.*$/, '').trim()
                    .replace(new RegExp('^`?' + w.name + '`?\\s*', 'i'), '').split(/\s+/)[0];
                expect(w.ddl).to.include('MODIFY `' + w.name + '` ' + type + ' CHARACTER SET ' + w.charset);
                checked++;
            }
        }
        expect(checked, 'the widen lockstep loop covered nothing').to.be.at.least(2);
    });
});
