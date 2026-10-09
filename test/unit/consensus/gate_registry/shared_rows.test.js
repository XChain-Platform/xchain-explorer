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
const fs = require('fs');
const core = require('../../../../src/consensus/gate_registry/core.js');

const SHARED_ROWS_PATH = require.resolve('../../../../src/consensus/gate_registry/shared_rows.js');
const PART_PATHS = [1, 2, 3, 4, 5].map((part) => require.resolve(
    '../../../../src/consensus/gate_registry/shared_rows_' + part + '.js'
));
const EXPECTED_ROW_COUNT = 108;
const LISTS_MARKET_HEIGHT_KEYS = [
    'list_owner_activation.LIST_OWNER_ACTIVATION',
    'empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES',
    'swap_edit_rematch_activation.SWAP_EDIT_REMATCH_ACTIVATION',
    'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK',
    'list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST',
    'list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN',
    'order_swap_maker_policy_admission.ORDER_SWAP_MAKER_POLICY_ADMISSION',
    'order_swap_payout_policy_activation.ORDER_SWAP_PAYOUT_POLICY_PER_TOKEN',
    'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH',
    'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH',
    'callback_compensation_activation.CALLBACK_COMPENSATES_EVERY_DEBITED_HOLDER',
];
const LISTS_MARKET_TIME_KEYS = [
    'dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION',
    'dispenser_freshness_proven_use_activation.DISPENSER_FRESHNESS_PROVEN_USE_ACTIVATION',
    'list_edit_remove_activation.LIST_EDIT_REMOVE_ACTIVATION',
];

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

    it('names UNARMED instead of spelling its numeric sentinel in shared gate rows', function () {
        const rows = [
            [PART_PATHS[0], 'archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION', 1],
            [PART_PATHS[4], 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION', 5],
            [PART_PATHS[4], 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION', 1],
            [PART_PATHS[4], 'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION', 2],
            [PART_PATHS[4], 'list_meta_activation.LIST_META_ACTIVATION', 2],
        ];
        for (const [partPath, key, expected] of rows) {
            const source = fs.readFileSync(partPath, 'utf8');
            const start = source.indexOf("addGate('" + key + "'");
            const end = source.indexOf('\n});', start);
            assert.notStrictEqual(start, -1, key);
            assert.notStrictEqual(end, -1, key);
            const declaration = source.slice(start, end);
            assert.strictEqual((declaration.match(/\bUNARMED\b/g) || []).length, expected, key);
            assert.doesNotMatch(declaration, /\b9999999999\b/, key);
        }
    });
});

describe('shared gate row registration', function () {
    it('rejects a malformed row queued with addGate', function () {
        const { addGate, registerRows } = freshSharedRows();

        assert.doesNotThrow(
            () => addGate('malformed.ROW', 'height', { regtest: 'not-a-height' })
        );

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

    it('arms every lists market height and time row from its matching environment', function () {
        const sharedRows = freshSharedRows();
        const registry = core.createRegistry();
        const env = {
            XC_LISTS_MARKET_REGTEST_ACTIVATION: '41',
            XC_LISTS_MARKET_REGTEST_TIME: '1790812800',
        };

        for (const key of LISTS_MARKET_HEIGHT_KEYS) sharedRows.addGate(key, 'height', { regtest: 0 });
        for (const key of LISTS_MARKET_TIME_KEYS) sharedRows.addGate(key, 'time', { regtest: 0 });
        sharedRows.registerRows(registry, env);

        for (const key of LISTS_MARKET_HEIGHT_KEYS) {
            assert.strictEqual(sharedRows.REGTEST_ARMING[key].env, 'XC_LISTS_MARKET_REGTEST_ACTIVATION', key);
            assert.strictEqual(registry.get(key).regtest, 41, key);
        }
        for (const key of LISTS_MARKET_TIME_KEYS) {
            assert.strictEqual(sharedRows.REGTEST_ARMING[key].env, 'XC_LISTS_MARKET_REGTEST_TIME', key);
            assert.strictEqual(registry.get(key).regtest, 1790812800, key);
        }
    });
});
