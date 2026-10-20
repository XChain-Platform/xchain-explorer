/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const { LIST } = require('../../../../src/action-detail/misc.js');

// Run the LIST edits hook over rows given in the order a database might return them
function editsFor(type, rows) {
    const data = { type };
    LIST.afterQuery3({}, data, rows);
    return data.edits;
}

describe('LIST edits order', function () {
    it('orders token edits by tick, then status, whatever order the rows arrive in', function () {
        const rows = [
            { tick: 'ZETA', status: 'valid' },
            { tick: 'ALPHA', status: 'valid' },
            { tick: 'MID', status: 'invalid: bad' },
            { tick: 'MID', status: 'valid' },
        ];
        const expected = [
            { tick: 'ALPHA', status: 'valid' },
            { tick: 'MID', status: 'invalid: bad' },
            { tick: 'MID', status: 'valid' },
            { tick: 'ZETA', status: 'valid' },
        ];
        assert.deepStrictEqual(editsFor(1, rows), expected);
        assert.deepStrictEqual(editsFor(1, rows.slice().reverse()), expected);
    });

    it('orders address edits by address in the same code-unit order as the list itself', function () {
        const rows = [
            { address: 'mzz', status: 'valid' },
            { address: 'Mzz', status: 'valid' },
            { address: 'maa', status: 'valid' },
        ];
        const edits = editsFor(2, rows);
        assert.deepStrictEqual(edits.map((e) => e.address), ['Mzz', 'maa', 'mzz']);
        assert.deepStrictEqual(edits.map((e) => e.address), rows.map((r) => r.address).sort());
        assert.deepStrictEqual(editsFor(2, rows.slice().reverse()), edits);
    });

    it('keeps a row whose item or status joined to nothing', function () {
        const edits = editsFor(1, [
            { tick: 'BETA', status: null },
            { tick: null, status: 'valid' },
            { tick: 'BETA', status: 'valid' },
        ]);
        assert.deepStrictEqual(edits, [
            { tick: null, status: 'valid' },
            { tick: 'BETA', status: null },
            { tick: 'BETA', status: 'valid' },
        ]);
    });
});
