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
            { mainnet: 9999999999, testnet: 9999999999, regtest: 0 }
        );
    });

    it('resolves the rollcall activation row exactly once', function () {
        const key = 'rollcall_activation.ROLLCALL_ACTIVATION';
        assert.strictEqual(gateRegistry.keys().filter((candidate) => candidate === key).length, 1);
        assert.doesNotThrow(() => gateRegistry.get(key));
    });
});
