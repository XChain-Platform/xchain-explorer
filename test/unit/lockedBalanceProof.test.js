/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Locked-balance (XCHAIN_ESC) proofs (SPV sub-tree spec §3, Stage B2).
 *
 * Two properties matter most here. First, escrow leaves change the CONTENTS
 * of balances_root, not the slot list, so a spendable-balance proof must keep
 * serving unchanged even when the tree also carries locked leaves.
 *
 * Second, THE REFUSAL: below the armed height, a non-membership proof for an
 * escrow key verifies perfectly against a root that never covered the domain,
 * and means nothing (there is no stored liveness column, so an idle domain
 * commits a root byte-identical to v1). Both the explorer and the SDK refuse
 * via their own separate activation-carrier copies, so a server that serves
 * anyway still cannot make a conforming client accept.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const M      = require('../../src/merkle.js');
const SUB    = require('../../src/state_subtree_activation.js');
const ProofServer = require('../../src/proofServer.js');

const EMPTY_ROOT = M.toHex(M.EMPTY_SMT_ROOT);
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);

// Minimal in-memory SMT builder over the same primitives the indexer commits
// with (shared shape with contractStateProof.test.js).
function buildStore(leaves) {
    const nodes = new Map();
    function descend(rootHex, keyBuf) {
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex, empty = false;
        for (let d = 0; d < M.SMT_DEPTH; d++) {
            const sibEmptyHex = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if (empty) { siblings[d] = sibEmptyHex; continue; }
            const row = nodes.get(cur);
            if (!row) { empty = true; siblings[d] = sibEmptyHex; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return siblings;
    }
    let root = EMPTY_ROOT;
    for (const [keyHex, leafHex] of leaves) {
        const keyBuf = M.toBuf(keyHex);
        const siblings = descend(root, keyBuf);
        let cur = (leafHex == null) ? EMPTY0_HEX : leafHex;
        for (let d = M.SMT_DEPTH - 1; d >= 0; d--) {
            const bit = M.bitAt(keyBuf, d), sib = siblings[d];
            const left  = (bit === 0) ? cur : sib;
            const right = (bit === 0) ? sib : cur;
            const parent = M.toHex(M.nodeHash(left, right));
            if (parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d])) nodes.set(parent, { left_hash: left, right_hash: right });
            cur = parent;
        }
        root = cur;
    }
    return { root, nodes };
}

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC';
const HEIGHT = 100;
const ADDR   = '1LockerAddr';
const TICK   = 'XCHAIN';
const LOCKED = '7';
const SPEND  = '5';

// A venue whose balances tree carries BOTH leaf domains for (ADDR, TICK): the
// spendable leaf and the locked leaf. state_root is the ordinary v1-shaped
// assembly, because the ESC domain adds no slot.
function makeVenue() {
    const balances = buildStore([
        [M.toHex(M.balanceKey(CHAIN, NET, ADDR, TICK)), M.toHex(M.amountLeaf(SPEND))],
        [M.toHex(M.escrowKey(CHAIN, NET, ADDR, TICK)),  M.toHex(M.amountLeaf(LOCKED))]
    ]);
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balances.root, stakes_root: EMPTY_ROOT }));
    const db = {
        async getCheckpointAtOrAbove() {
            return { chain: CHAIN, network: NET, block_index: HEIGHT, block_hash: 'c0'.repeat(32),
                ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                checkpoint_seq: 0, snapshot_block: HEIGHT, state_root: stateRoot, state_root_version: 2,
                block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
        },
        async getStateTreeRow() {
            return { balances_root: balances.root, stakes_root: EMPTY_ROOT, state_root: stateRoot,
                     block_merkle_root: 'e5'.repeat(32), contract_state_root: null };
        },
        async getStateNode(config, nodeHash) { return balances.nodes.get(nodeHash) || null; },
        async getLockedAmountAtHeight() { return LOCKED; },
        async getNetBalance18AtHeight() { return SPEND + '.000000000000000000'; },
        async getMaxBlockIndex() { return HEIGHT; }
    };
    return { server: new ProofServer(db), stateRoot, balancesRoot: balances.root };
}

const ARM_KEY = CHAIN + ':' + NET;

function armExplorer() { SUB.ESCROW_LOCKED_LEAF_ACTIVATION[ARM_KEY] = 0; }
function disarmExplorer() { delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION[ARM_KEY]; }

describe('SPV Stage B: spendable proofs survive escrow leaves in the tree @regression', function () {

    afterEach(disarmExplorer);

    it('a balance proof still serves and binds when the tree carries a locked leaf', async function () {
        armExplorer();
        const { server, stateRoot, balancesRoot } = makeVenue();
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        assert.ok(!r.error, 'balance proof must still serve: ' + r.error);
        assert.strictEqual(r.proof.amount, M.canonicalAmount(SPEND));
        assert.ok(M.verifyCompressedSmtProof(balancesRoot, M.balanceKey(CHAIN, NET, ADDR, TICK),
                                             r.proof.smt_proof.leaf_value, r.proof.smt_proof.compressed),
            'the spendable leaf must still prove against a tree that also holds the locked leaf');
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(balancesRoot),
                                           r.proof.sub_root_path.index, r.proof.sub_root_path.siblings));
    });
});

describe('SPV Stage B: lockedBalanceProof @regression', function () {

    afterEach(disarmExplorer);

    it('a membership proof verifies, binds, and carries amountLeaf(amount)', async function () {
        armExplorer();
        const { server, stateRoot, balancesRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        assert.ok(!r.error, 'no error: ' + r.error);
        const p = r.proof;
        assert.strictEqual(p.amount, M.canonicalAmount(LOCKED));
        // The committed leaf is the SAME amount encoding the spendable leaf uses.
        assert.strictEqual(p.smt_proof.leaf_value, M.toHex(M.amountLeaf(LOCKED)));
        const keyBuf = M.escrowKey(CHAIN, NET, ADDR, TICK);
        assert.ok(M.verifyCompressedSmtProof(balancesRoot, keyBuf, p.smt_proof.leaf_value, p.smt_proof.compressed),
            'SMT membership proof must verify against balances_root');
        // The sub_root_path pins the balances_root slot, exactly as the spendable
        // proof does: same sub-root, second key domain.
        assert.strictEqual(p.sub_root_path.index, M.STATE_SUBTREES.indexOf('balances_root'));
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(p.balances_root),
                                           p.sub_root_path.index, p.sub_root_path.siblings));
    });

    it('nothing locked at an armed height is a verifiable non-inclusion with amount "0"', async function () {
        armExplorer();
        const { server, balancesRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, '1NothingLocked', TICK, HEIGHT);
        assert.ok(!r.error, 'no error: ' + r.error);
        assert.strictEqual(r.proof.smt_proof.leaf_value, null);
        assert.strictEqual(r.proof.amount, M.canonicalAmount('0'));
        assert.ok(M.verifyCompressedSmtProof(balancesRoot, M.escrowKey(CHAIN, NET, '1NothingLocked', TICK),
                                             null, r.proof.smt_proof.compressed),
            'non-inclusion must verify: at an ARMED height, no leaf really does mean zero locked');
    });

    it('REFUSES below the armed height instead of proving absence the root never covered', async function () {
        // Map inert (the disarmed default): the §4 hazard branch.
        const { server } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        assert.strictEqual(r.error, 'ESCROW_LEAF_NOT_COMMITTED');
    });
});

describe('SPV Stage B: lockedBalanceProof through the real SDK verifier @regression', function () {

    // The server's actual response fed to the SDK's client-side verifier: two
    // independent implementations of "what does this proof mean" must agree.
    // Skipped rather than failed when the sibling repo is absent.
    let light = null, sdkSub = null;
    try {
        light  = require('../../../xchain-sdk/src/light.js');
        sdkSub = require('../../../xchain-sdk/src/state_subtree_activation.js');
    } catch (e) { light = null; sdkSub = null; }

    function armSdk() { sdkSub.ESCROW_LOCKED_LEAF_ACTIVATION[ARM_KEY] = 0; }
    function disarmSdk() { delete sdkSub.ESCROW_LOCKED_LEAF_ACTIVATION[ARM_KEY]; }
    afterEach(function () { disarmExplorer(); if (sdkSub) disarmSdk(); });

    it('a membership proof verifies and yields the locked amount', async function () {
        if (!light) return this.skip();
        armExplorer(); armSdk();
        const { server, stateRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        const v = light.verifyLockedBalanceProof(r.proof, stateRoot, CHAIN, NET);
        assert.strictEqual(v.reason, null);
        assert.strictEqual(v.verified, true);
        assert.strictEqual(v.amount, M.canonicalAmount(LOCKED));
    });

    it('a non-inclusion proof verifies as zero locked', async function () {
        if (!light) return this.skip();
        armExplorer(); armSdk();
        const { server, stateRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, '1NothingLocked', TICK, HEIGHT);
        const v = light.verifyLockedBalanceProof(r.proof, stateRoot, CHAIN, NET);
        assert.strictEqual(v.verified, true);
        assert.strictEqual(v.amount, M.canonicalAmount('0'));
    });

    it('DEFENSE IN DEPTH: a client whose own map is inert refuses whatever the server served', async function () {
        if (!light) return this.skip();
        // Server armed, client NOT: the two carriers are separate module
        // instances, which is precisely the deployment skew (or hostile server)
        // this vector models. The client must refuse on ITS liveness knowledge.
        armExplorer();                                   // sdk deliberately NOT armed
        const { server, stateRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        assert.ok(!r.error, 'server (armed) serves: ' + r.error);
        const v = light.verifyLockedBalanceProof(r.proof, stateRoot, CHAIN, NET);
        assert.strictEqual(v.verified, false);
        assert.strictEqual(v.reason, 'ESCROW_LEAF_NOT_COMMITTED');
    });

    it('the two balances_root leaf domains cannot answer for each other', async function () {
        if (!light) return this.skip();
        armExplorer(); armSdk();
        const { server, stateRoot } = makeVenue();
        const locked = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        const spend  = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        // A locked proof fed to the spendable verifier, and vice versa: each
        // derives its own key domain, so both fail KEY_MISMATCH rather than
        // verifying an amount from the other domain.
        assert.strictEqual(light.verifyBalanceProof(locked.proof, stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
        assert.strictEqual(light.verifyLockedBalanceProof(spend.proof, stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
    });

    it('a tampered amount fails: the leaf binds the served amount to the root', async function () {
        if (!light) return this.skip();
        armExplorer(); armSdk();
        const { server, stateRoot } = makeVenue();
        const r = await server.lockedBalanceProof({ coin: COIN }, CHAIN, NET, ADDR, TICK, HEIGHT);
        const tampered = Object.assign({}, r.proof, { amount: '8' });
        assert.strictEqual(light.verifyLockedBalanceProof(tampered, stateRoot, CHAIN, NET).reason, 'LEAF_AMOUNT_MISMATCH');
    });
});
