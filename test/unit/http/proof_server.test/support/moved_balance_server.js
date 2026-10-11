/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 ********************************************************************/

'use strict';

const assert = require('assert');
const M = require('../../../../../src/consensus/merkle.js');
const ProofServer = require('../../../../../src/http/proof_server.js');
const { EMPTY_ROOT, buildStore, CHAIN, NET, ADDR_A, TICK } = require('./helpers.js');

// Regression: the served amount must be the net balance committed AT the
// checkpoint height, not the current tip. The mock ledger credits ADDR_A once
// before the checkpoint and once after, so the height-bounded and unbounded (tip)
// queries diverge, and the committed SMT leaf is built from the checkpoint-height
// net. The old code queried the unbounded balance instead, which no longer
// preimages the leaf and trips the real xchain-sdk verifier's LEAF_AMOUNT_MISMATCH.
const CP_HEIGHT = 100;
// Per-block ledger for (ADDR_A, TICK): +5 at block 50 (<= checkpoint),
// +7 at block 150 (> checkpoint). Net at height 100 == 5; net at tip == 12.
const LEDGER = [
    { kind: 'credit', block_index: 50,  amount: '5' },
    { kind: 'credit', block_index: 150, amount: '7' }
];
function netAtHeight(h) {
    let n = 0;
    for (const e of LEDGER) if (e.block_index <= h) n += (e.kind === 'credit' ? 1 : -1) * Number(e.amount);
    return String(n);
}

function makeMovedServer() {
    const cpNet   = netAtHeight(CP_HEIGHT);                       // '5' (committed leaf source)
    const tipNet  = netAtHeight(Number.MAX_SAFE_INTEGER);        // '12' (current tip)
    assert.notStrictEqual(M.canonicalAmount(cpNet), M.canonicalAmount(tipNet),
        'test precondition: the balance must actually move after the checkpoint');
    const keyA   = M.balanceKey(CHAIN, NET, ADDR_A, TICK);
    const leafA  = M.toHex(M.amountLeaf(cpNet));                  // leaf committed at CP height
    const built  = buildStore([[M.toHex(keyA), leafA]]);
    const balancesRoot = built.root;
    const stakesRoot   = EMPTY_ROOT;
    const stateRoot    = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const db = {
        async getCheckpointAtOrAbove() {
            return { chain: CHAIN, network: NET, block_index: CP_HEIGHT, block_hash: 'c0'.repeat(32),
                ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                checkpoint_seq: 0, snapshot_block: CP_HEIGHT, state_root: stateRoot, state_root_version: 1,
                block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
        },
        async getStateTreeRow() {
            return { balances_root: balancesRoot, stakes_root: stakesRoot, state_root: stateRoot, block_merkle_root: 'e5'.repeat(32) };
        },
        async getStateNode(config, nodeHash) { return built.nodes.get(nodeHash) || null; },
        // Real height-bounded semantics (what the SQL variant computes): sum
        // ledger rows with block_index <= blockIndex for the queried address.
        async getNetBalance18AtHeight(config, address, tick, blockIndex) {
            return (address === ADDR_A) ? (netAtHeight(Number(blockIndex)) + '.000000000000000000') : '0';
        },
        // The unbounded (tip) query the OLD code called: returns the moved
        // balance, which no longer preimages the committed leaf. If the fix
        // regresses to this call site, the SDK rejects and this test fails.
        async getNetBalance18(config, address) {
            return (address === ADDR_A) ? (tipNet + '.000000000000000000') : '0';
        },
        async getMaxBlockIndex() { return 150; }                 // tip past the checkpoint
    };
    return { server: new ProofServer(db), balancesRoot, stateRoot, cpNet, tipNet };
}

module.exports = { CP_HEIGHT, makeMovedServer };
