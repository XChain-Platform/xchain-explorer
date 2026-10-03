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
const gateRegistry = require('../../../src/consensus/gate_registry.js');

describe('consensus-bound registry rows', function () {
    it('resolves the anchor bundle order activation table', function () {
        assert.deepStrictEqual(
            gateRegistry.get('anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION'),
            { mainnet: 9999999999, 'BTC:testnet': 154971, 'LTC:testnet': 4905844, 'DOGE:testnet': 67961578, testnet: 9999999999, regtest: 0 }
        );
    });

    it('resolves the rollcall activation row exactly once', function () {
        const key = 'rollcall_activation.ROLLCALL_ACTIVATION';
        assert.strictEqual(gateRegistry.keys().filter((candidate) => candidate === key).length, 1);
        assert.doesNotThrow(() => gateRegistry.get(key));
    });
});

describe('price scale registry rows', function () {
    const prefix = 'price_scale_activation.';

    it('registers each price scale row exactly once', function () {
        const names = [
            'PRICE_SCALE_MAX_DECIMALS',
            'PRICE_SCALE_ACTIVATION',
            'PRICE_VALUE_RE_LEGACY',
            'PRICE_VALUE_RE_CANONICAL',
            'PRICE_V1_CANONICAL_ACTIVATION',
            'PRICE_V1_FEE_RE_CANONICAL',
            'PRICE_V1_VALUE_MAX_LENGTH',
            'PRICE_V1_FEE_MAX_LENGTH'
        ];

        for (const name of names) {
            const key = `${prefix}${name}`;
            assert.strictEqual(gateRegistry.keys().filter((candidate) => candidate === key).length, 1);
        }
    });

    it('pins the price scale activation and decimal limit', function () {
        assert.deepStrictEqual(
            gateRegistry.get(`${prefix}PRICE_SCALE_ACTIVATION`),
            { mainnet: 0, testnet: 0, regtest: 0 }
        );
        assert.strictEqual(gateRegistry.get(`${prefix}PRICE_SCALE_MAX_DECIMALS`), 8);
    });

    it('pins canonical price value syntax', function () {
        const canonical = gateRegistry.get(`${prefix}PRICE_VALUE_RE_CANONICAL`);

        assert.strictEqual(canonical.test('1.5'), true);
        assert.strictEqual(canonical.test('12345.12345678'), true);
        assert.strictEqual(canonical.test('01.5'), false);
        assert.strictEqual(canonical.test('1.123456789'), false);
    });

    it('pins the PRICE v1 canonical rows', function () {
        assert.deepStrictEqual(
            gateRegistry.get(`${prefix}PRICE_V1_CANONICAL_ACTIVATION`),
            { mainnet: gateRegistry.UNARMED, 'BTC:testnet': 1791039938, 'LTC:testnet': 1791039938, 'DOGE:testnet': 1791039938, testnet: gateRegistry.UNARMED, regtest: 0 }
        );
        assert.deepStrictEqual(
            gateRegistry.get(`${prefix}PRICE_V1_FEE_RE_CANONICAL`),
            /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/
        );
        assert.strictEqual(gateRegistry.get(`${prefix}PRICE_V1_VALUE_MAX_LENGTH`), 19);
        assert.strictEqual(gateRegistry.get(`${prefix}PRICE_V1_FEE_MAX_LENGTH`), 20);
    });
});
