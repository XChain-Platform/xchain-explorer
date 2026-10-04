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

const assert = require('assert');
const core = require('../../../../src/consensus/gate_registry/core.js');

const SHARED_ROWS_PATH = require.resolve('../../../../src/consensus/gate_registry/shared_rows.js');
const PART_PATHS = [1, 2, 3, 4, 5].map((part) => require.resolve(
    '../../../../src/consensus/gate_registry/shared_rows_' + part + '.js'
));
const EXPECTED_ROW_COUNT = 106;

function freshSharedRows() {
    delete require.cache[SHARED_ROWS_PATH];
    return require(SHARED_ROWS_PATH);
}

function loadSharedRows() {
    const sharedRows = freshSharedRows();
    for (const partPath of PART_PATHS) {
        delete require.cache[partPath];
        require(partPath);
    }
    return sharedRows;
}

describe('shared gate row exports', function () {
    it('exports the core sentinels and REGTEST_ARMING rules', function () {
        const sharedRows = freshSharedRows();
        const foldRule = sharedRows.REGTEST_ARMING[
            'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION'
        ];

        assert.strictEqual(sharedRows.UNARMED, core.UNARMED);
        assert.strictEqual(sharedRows.UNPINNED, core.UNPINNED);
        assert.notStrictEqual(sharedRows.UNARMED, sharedRows.UNPINNED);
        assert.deepStrictEqual(foldRule.keys, ['regtest']);
        assert.strictEqual(foldRule.env, 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION');
    });
});

describe('shared gate row registration', function () {
    it('rejects a malformed row in addGate', function () {
        const registry = core.createRegistry();

        assert.throws(
            () => registry.addGate('malformed.ROW', 'height', { regtest: 'not-a-height' }),
            /must be a finite number or UNPINNED/
        );
    });

    it('rejects a malformed row queued with addGate', function () {
        const { addGate, registerRows } = freshSharedRows();

        addGate('malformed.ROW', 'height', { regtest: 'not-a-height' });

        assert.throws(
            () => registerRows(core.createRegistry(), {}),
            /must be a finite number or UNPINNED/
        );
    });

    it('registers every shared row once and rejects a second registration', function () {
        const { registerRows } = loadSharedRows();
        const registry = core.createRegistry();

        registerRows(registry, {});

        assert.strictEqual(registry.keys().length, EXPECTED_ROW_COUNT);
        assert.strictEqual(new Set(registry.keys()).size, EXPECTED_ROW_COUNT);
        assert.throws(() => registerRows(registry, {}), /duplicate key/);
        assert.strictEqual(registry.keys().length, EXPECTED_ROW_COUNT);
    });
});

describe('shared gate row regtest arming', function () {
    it('arms only the listed regtest entry from the rule environment', function () {
        const sharedRows = freshSharedRows();
        const key = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
        const env = { UNRELATED_REGTEST_ACTIVATION: '37' };
        const committed = { mainnet: sharedRows.UNARMED, testnet: 51, regtest: sharedRows.UNPINNED };
        const registry = core.createRegistry();

        sharedRows.addGate(key, 'height', committed);
        sharedRows.registerRows(registry, env);
        assert.deepStrictEqual(registry.get(key), committed);

        env[sharedRows.REGTEST_ARMING[key].env] = '37';
        assert.deepStrictEqual(registry.get(key), {
            mainnet: sharedRows.UNARMED,
            testnet: 51,
            regtest: 37,
        });
        assert.deepStrictEqual(committed, {
            mainnet: sharedRows.UNARMED,
            testnet: 51,
            regtest: sharedRows.UNPINNED,
        });
    });
});
