// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const gateRegistry = require('../../../src/consensus/gate_registry.js');

const ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const KEYS = [
    'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION',
    'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION',
];
const present = KEYS.filter((key) => gateRegistry.has(key));

function withEnv(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

describe('consensus gate registry anchor fold rows', function () {
    it('carries both rows together or neither row', function () {
        assert.ok(present.length === 0 || present.length === 2);
    });

    it('ships both activation maps inert on mainnet and armed at the v0.21.3 testnet heights', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.deepStrictEqual(gateRegistry.get(key), {
                    mainnet: 9999999999,
                    'BTC:testnet': 154971,
                    'LTC:testnet': 4905844,
                    'DOGE:testnet': 67961578,
                    testnet: 9999999999,
                    regtest: null,
                });
            }
        });
    });

    it('arms both regtest entries from the shared venue variable', function () {
        withEnv('armed', () => {
            for (const key of KEYS) assert.strictEqual(gateRegistry.get(key).regtest, 0);
        });
    });

    it('stays inactive below the sentinel on mainnet and testnet', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.strictEqual(gateRegistry.activeAt(key, 'mainnet', null, 99999999, null), false);
                assert.strictEqual(gateRegistry.activeAt(key, 'testnet', null, 99999999, null), false);
            }
        });
    });
});
