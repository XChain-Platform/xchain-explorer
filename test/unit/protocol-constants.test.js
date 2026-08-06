// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/protocol/constants.js: the single source of truth for
// the protocol size/gas caps that multiple services enforce independently.
// These are deliberately pinned (a silent drift here is exactly the
// cross-service failure class the file exists to prevent), plus the structural
// invariants the surrounding code relies on.

const assert = require('assert');
const C = require('../../src/protocol/constants.js');

describe('protocol/constants', function () {
    it('pins the on-chain ACTION size caps', function () {
        assert.strictEqual(C.MAX_ACTION_DATA_LENGTH, 8192);
        assert.strictEqual(C.OP_RETURN_PUSH_OVERHEAD, 3);
        assert.strictEqual(C.MAX_CODE_SIZE, 65536);
    });

    it('pins the VM call-depth / gas floor', function () {
        assert.strictEqual(C.VM_MAX_CALL_DEPTH, 4);
        assert.strictEqual(C.VM_MIN_CALL_GAS, 5000);
    });

    it('keeps XCALL gas/hop/deadline bounds internally consistent', function () {
        assert.strictEqual(C.XCALL_MIN_GAS, C.VM_MIN_CALL_GAS, 'XCALL floor equals the same-chain call floor');
        assert.strictEqual(C.XCALL_MAX_GAS, 200000);
        assert.ok(C.XCALL_MIN_GAS < C.XCALL_MAX_GAS);
        assert.strictEqual(C.XCALL_MAX_HOPS, 2);
        assert.ok(C.XCALL_MIN_DEADLINE_BLOCKS < C.XCALL_MAX_DEADLINE_BLOCKS);
        assert.strictEqual(C.XCALL_MIN_DEADLINE_BLOCKS, 10);
        assert.strictEqual(C.XCALL_MAX_DEADLINE_BLOCKS, 4000);
        assert.strictEqual(C.XCALL_MAX_RETURN_BYTES, 1024);
        assert.strictEqual(C.XCALL_MAX_CALLS_PER_BLOCK, 25);
    });

    it('sizes a DEPLOY chunk part to stay under the compiled ACTION cap', function () {
        assert.strictEqual(C.MAX_DEPLOY_CHUNKS, 16);
        assert.strictEqual(C.MAX_DEPLOYCHUNK_PART_BYTES, 7800);
        assert.ok(
            C.MAX_DEPLOYCHUNK_PART_BYTES + C.OP_RETURN_PUSH_OVERHEAD < C.MAX_ACTION_DATA_LENGTH,
            'a single chunk part plus its push prefix must fit one on-chain ACTION push'
        );
    });

    it('shapes the genesis-testnet activation maps as {mainnet>0, testnet:0, regtest:0}', function () {
        // CHECKPOINT_COMMITMENT_ACTIVATION is deliberately excluded:  lead
        // 0e418c8c armed its testnet to 146000 (the SPV root suffix must not be
        // signed before every chain is past its STATE_COMMITMENT height).
        for (const name of ['STAKE_WEIGHTED_QUORUM_ACTIVATION', 'EQUIV_HEADER_ACTIVATION', 'ANCHOR_REWARD_ACTIVATION']) {
            const m = C[name];
            assert.ok(m && typeof m === 'object', `${name} must be a map`);
            assert.ok(Number.isInteger(m.mainnet) && m.mainnet > 0, `${name}.mainnet must be armed`);
            assert.strictEqual(m.testnet, 0, `${name}.testnet activates at genesis`);
            assert.strictEqual(m.regtest, 0, `${name}.regtest activates at genesis`);
        }
    });

    it('CHECKPOINT_COMMITMENT_ACTIVATION arms testnet at 146000, regtest at genesis ( keying-skew fix)', function () {
        const m = C.CHECKPOINT_COMMITMENT_ACTIVATION;
        assert.ok(m && typeof m === 'object', 'CHECKPOINT_COMMITMENT_ACTIVATION must be a map');
        // Pin the exact armed mainnet flag-day (BTC anchor ~2026-08-04); `> 0` let a
        // one-sided edit of this copy pass green while moving a live consensus height.
        assert.strictEqual(m.mainnet, 961000, 'mainnet arms at the BTC-anchored 961000 flag-day');
        assert.strictEqual(m.testnet, 146000, 'testnet arms only after every STATE_COMMITMENT testnet threshold');
        assert.strictEqual(m.regtest, 0, 'regtest activates at genesis');
    });

    it('pins the anchor/oracle economic constants', function () {
        assert.strictEqual(C.ANCHOR_REWARD_AMOUNT, '10.00000000', 'reward is a fixed 8-dp decimal string, never a float');
        assert.strictEqual(C.ORACLE_DEVIATION_THRESHOLD, 0.05);
        assert.strictEqual(C.PRICE_MAX, 10_000_000_000);
        assert.strictEqual(C.GAS_TICK, 'XCHAIN');
    });

    it('exposes the fiat allow-list with USD present and no duplicates', function () {
        assert.ok(Array.isArray(C.VALID_FIAT_CODES));
        assert.ok(C.VALID_FIAT_CODES.includes('USD'));
        assert.strictEqual(new Set(C.VALID_FIAT_CODES).size, C.VALID_FIAT_CODES.length, 'no duplicate fiat codes');
        for (const code of C.VALID_FIAT_CODES) assert.match(code, /^[A-Z]{3}$/, 'ISO-4217 style 3-letter codes');
    });
});
