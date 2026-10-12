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
const {
    coerceMirrorValue,
    priceUpsertSql,
    applyMirrorWrite
} = require('../../../../src/hub/hub_db_sync/mirror_write.js');

describe('coerceMirrorValue', function () {
    it('returns non-strings and non-ISO strings unchanged', function () {
        const objectValue = { value: '2026-08-09T10:11:12Z' };

        assert.strictEqual(coerceMirrorValue(objectValue, 'datetime'), objectValue);
        assert.strictEqual(coerceMirrorValue(42, 'timestamp'), 42);
        assert.strictEqual(coerceMirrorValue('not a timestamp', 'datetime'), 'not a timestamp');
    });

    it('formats zoned and zone-less timestamps as UTC SQL datetimes', function () {
        assert.strictEqual(
            coerceMirrorValue('2026-08-09T10:11:12.345Z', 'datetime'),
            '2026-08-09 10:11:12'
        );
        assert.strictEqual(
            coerceMirrorValue('2026-08-09T10:11:12', 'timestamp(6)'),
            '2026-08-09 10:11:12'
        );
        assert.strictEqual(
            coerceMirrorValue('2026-08-09T10:11:12-02:00', 'timestamp'),
            '2026-08-09 12:11:12'
        );
    });

    it('does not coerce other column types or unparseable dates', function () {
        const iso = '2026-08-09T10:11:12Z';
        const invalid = '2026-13-40T25:61:61Z';

        assert.strictEqual(coerceMirrorValue(iso, 'varchar(255)'), iso);
        assert.strictEqual(coerceMirrorValue(invalid, 'datetime'), invalid);
    });
});

describe('priceUpsertSql', function () {
    it('builds finalized-only updates for a tuple per row without id', function () {
        const sql = priceUpsertSql(
            ['id', 'round_number', 'coin_pair', 'status', 'price', 'created_at'],
            2
        );
        const expected = 'INSERT INTO price_snapshots '
            + '(`round_number`, `coin_pair`, `status`, `price`, `created_at`) '
            + 'VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE '
            + "`price` = IF(VALUES(status) = 'finalized', VALUES(`price`), `price`), "
            + "`created_at` = IF(VALUES(status) = 'finalized', VALUES(`created_at`), `created_at`), "
            + "status = IF(VALUES(status) = 'finalized', 'finalized', status)";

        assert.strictEqual(sql, expected);
    });
});

describe('applyMirrorWrite', function () {
    it('prefers doQueryStrict and passes query arguments through', async function () {
        const calls = [];
        const args = ['finalized', 12];
        const db = {
            doQueryStrict: async (...values) => {
                calls.push(values);
                return 'strict result';
            },
            doQuery: async () => assert.fail('doQuery must not run')
        };

        assert.strictEqual(await applyMirrorWrite(db, 'UPDATE prices', args), 'strict result');
        assert.deepStrictEqual(calls, [['UPDATE prices', args]]);
        assert.strictEqual(calls[0][1], args);
    });

    it('falls back to doQuery and passes query arguments through', async function () {
        const calls = [];
        const args = ['pending', 13];
        const db = {
            doQuery: async (...values) => {
                calls.push(values);
                return 'fallback result';
            }
        };

        assert.strictEqual(await applyMirrorWrite(db, 'INSERT prices', args), 'fallback result');
        assert.deepStrictEqual(calls, [['INSERT prices', args]]);
        assert.strictEqual(calls[0][1], args);
    });
});
