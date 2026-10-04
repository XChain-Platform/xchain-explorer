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
const { UNARMED } = require('../../../../src/consensus/gate_registry/core.js');
const { registerLocalRows } = require('../../../../src/consensus/gate_registry/local_rows.js');

const EXPECTED_ROWS = [
    {
        key: 'anchor_activation.ANCHOR_ACTIVATION',
        unit: 'height',
        value: { mainnet: 6360000, testnet: 67858600, regtest: 0 },
    },
    {
        key: 'owner_withdraw_opt_in.OWNER_WITHDRAW_OPT_IN',
        unit: 'time',
        value: { mainnet: UNARMED, testnet: 1790492400, regtest: 0 },
    },
];

function createStubRegistry() {
    const keys = new Set();
    const rows = [];

    return {
        rows,
        addGate(key, unit, value) {
            if (keys.has(key)) throw new Error('duplicate key ' + key);
            keys.add(key);
            rows.push({ key, unit, value });
        },
    };
}

describe('local gate registry rows', function () {
    it('registers every local row once with complete network tables', function () {
        const registry = createStubRegistry();

        registerLocalRows(registry);

        assert.deepStrictEqual(registry.rows, EXPECTED_ROWS);
        for (const row of registry.rows) {
            assert.deepStrictEqual(Object.keys(row.value).sort(), ['mainnet', 'regtest', 'testnet']);
        }
    });

    it('refuses to register any local row twice', function () {
        const registry = createStubRegistry();

        registerLocalRows(registry);

        assert.throws(() => registerLocalRows(registry), /duplicate key/);
        assert.deepStrictEqual(registry.rows, EXPECTED_ROWS);
    });
});
