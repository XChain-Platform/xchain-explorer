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
 *
 * SPV light-client proof server (Phase 3) round-trip unit tests.
 *
 * Builds a real balances SMT node store with the merkle.js twin (the same module
 * the indexer commits with), mocks the DB reads, and asserts the proof server
 * produces proofs that VERIFY locally against the committed state_root: membership
 * for a present balance, non-inclusion for a zero balance, and the §4.4 sub_root_path
 * binding balances_root into state_root. A drift in the explorer twin or the walk
 * breaks verification, exactly as it would for a real client.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M      = require('../../src/merkle.js');
const ProofServer = require('../../src/proofServer.js');

// Minimal in-memory persistent SMT (the update half of stateCommitment.PersistentSMT)
// so the test can materialize the exact node store the proof walk reads.
const EMPTY0_HEX    = M.toHex(M.EMPTY[0]);
const EMPTY_ROOT    = M.toHex(M.EMPTY[M.SMT_DEPTH]);
function buildStore(leaves) {
    const nodes = new Map();                       // node_hash -> {left_hash, right_hash}
    const get = (h) => nodes.get(h) || null;
    function descend(rootHex, keyBuf) {
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex, empty = false;
        for (let d = 0; d < M.SMT_DEPTH; d++) {
            const sibEmpty = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if (empty) { siblings[d] = sibEmpty; continue; }
            const row = get(cur);
            if (!row) { empty = true; siblings[d] = sibEmpty; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return siblings;
    }
    function update(rootHex, keyBuf, leafHex) {
        const siblings = descend(rootHex, keyBuf);
        let cur = (leafHex == null) ? EMPTY0_HEX : leafHex;
        for (let d = M.SMT_DEPTH - 1; d >= 0; d--) {
            const bit = M.bitAt(keyBuf, d), sib = siblings[d];
            const left  = (bit === 0) ? cur : sib;
            const right = (bit === 0) ? sib : cur;
            const parent = M.toHex(M.nodeHash(left, right));
            if (parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d])) nodes.set(parent, { left_hash: left, right_hash: right });
            cur = parent;
        }
        return cur;
    }
    let root = EMPTY_ROOT;
    for (const [keyHex, leafHex] of leaves) root = update(root, M.toBuf(keyHex), leafHex);
    return { root, nodes };
}

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_Z = '1AddrZzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const TICK   = 'XCHAIN';

function makeServer(amountA) {
    const keyA   = M.balanceKey(CHAIN, NET, ADDR_A, TICK);
    const leafA  = M.toHex(M.amountLeaf(amountA));
    const built  = buildStore([[M.toHex(keyA), leafA]]);
    const balancesRoot = built.root;
    const stakesRoot   = EMPTY_ROOT;                                  // no stakes on this chain
    const stateRoot    = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
    const db = {
        async getCheckpointAtOrAbove() {
            return { chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
                ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                checkpoint_seq: 0, snapshot_block: 100, state_root: stateRoot, state_root_version: 1,
                block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
        },
        async getStateTreeRow() {
            return { balances_root: balancesRoot, stakes_root: stakesRoot, state_root: stateRoot, block_merkle_root: 'e5'.repeat(32) };
        },
        async getStateNode(config, nodeHash) { return built.nodes.get(nodeHash) || null; },
        async getNetBalance18(config, address) { return (address === ADDR_A) ? (amountA + '.000000000000000000') : '0'; },
        async getMaxBlockIndex() { return 100; }    // chain tip == checkpoint height (lag 0)
    };
    return { server: new ProofServer(db), balancesRoot, stakesRoot, stateRoot };
}

describe('SPV Phase 3: ProofServer.balanceProof round-trip', function () {

    it('membership proof verifies against the committed state_root', async function () {
        const { server, balancesRoot, stateRoot } = makeServer('5');
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, 100);
        assert.ok(!r.error, 'no error: ' + r.error);
        const p = r.proof;
        assert.strictEqual(p.amount, M.canonicalAmount('5'));
        assert.strictEqual(p.state_root, stateRoot);
        assert.strictEqual(p.height, 100);
        // 1. The SMT proof recomputes balances_root from the (key, leaf, compressed siblings).
        const keyBuf = M.balanceKey(CHAIN, NET, ADDR_A, TICK);
        assert.ok(M.verifyCompressedSmtProof(balancesRoot, keyBuf, p.smt_proof.leaf_value, p.smt_proof.compressed),
            'SMT membership proof must verify against balances_root');
        // 2. The leaf the proof commits is exactly amountLeaf(amount).
        assert.strictEqual(p.smt_proof.leaf_value, M.toHex(M.amountLeaf(p.amount)));
        // 3. sub_root_path binds balances_root into the committed state_root.
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(p.balances_root), p.sub_root_path.index, p.sub_root_path.siblings),
            'sub_root_path must bind balances_root into state_root');
    });

    it('a zero balance comes back as a verifiable non-inclusion proof', async function () {
        const { server, balancesRoot, stateRoot } = makeServer('5');
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_Z, TICK, 100);
        assert.ok(!r.error);
        const p = r.proof;
        assert.strictEqual(p.smt_proof.leaf_value, null, 'absent key => null leaf (non-inclusion)');
        assert.strictEqual(p.amount, M.canonicalAmount('0'));
        const keyBuf = M.balanceKey(CHAIN, NET, ADDR_Z, TICK);
        assert.ok(M.verifyCompressedSmtProof(balancesRoot, keyBuf, null, p.smt_proof.compressed),
            'non-inclusion proof must verify against balances_root');
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(p.balances_root), p.sub_root_path.index, p.sub_root_path.siblings));
    });

    it('refuses to serve when the local state tree does not reassemble the signed state_root', async function () {
        const { server } = makeServer('5');
        server.db.getStateTreeRow = async () => ({ balances_root: 'de'.repeat(32), stakes_root: EMPTY_ROOT,
            state_root: 'ff'.repeat(32), block_merkle_root: 'e5'.repeat(32) });
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, 100);
        assert.strictEqual(r.error, 'PROOF_STATE_ROOT_MISMATCH');
    });

    it('reports CHECKPOINT_PRE_COMMITMENT for a pre-flag-day checkpoint (null state_root)', async function () {
        const { server } = makeServer('5');
        server.db.getCheckpointAtOrAbove = async () => ({ chain: CHAIN, network: NET, block_index: 100,
            checkpoint_seq: 0, snapshot_block: 100, state_root: null, validator_signatures: '[]' });
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, 100);
        assert.strictEqual(r.error, 'CHECKPOINT_PRE_COMMITMENT');
    });

    it('attaches advisory freshness (chain_tip / lag / stale) to the checkpoint', async function () {
        const { server } = makeServer('5');
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, 100);
        assert.ok(!r.error);
        assert.strictEqual(r.checkpoint.chain_tip, 100);    // mock tip == checkpoint height
        assert.strictEqual(r.checkpoint.lag, 0);
        assert.strictEqual(r.checkpoint.stale, false);
    });

    it('flags the checkpoint stale when it trails the chain tip past the bound', async function () {
        const { server } = makeServer('5');
        server.staleLagBlocks = 100;
        server.db.getMaxBlockIndex = async () => 100000;    // checkpoint at 100, tip far ahead
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, 100);
        assert.ok(!r.error);
        assert.strictEqual(r.checkpoint.chain_tip, 100000);
        assert.strictEqual(r.checkpoint.lag, 99900);
        assert.strictEqual(r.checkpoint.stale, true);
    });

    it('forwards a null height so the db binds to the latest checkpoint', async function () {
        const { server } = makeServer('5');
        let seenHeight = 'unset';
        const orig = server.db.getCheckpointAtOrAbove.bind(server.db);
        server.db.getCheckpointAtOrAbove = async (config, height) => { seenHeight = height; return orig(config, height); };
        await server.balanceProof({ coin: COIN }, CHAIN, NET, ADDR_A, TICK, null);
        assert.strictEqual(seenHeight, null, 'a null height must reach getCheckpointAtOrAbove (latest binding)');
    });
});

describe('SPV Phase 3: ProofServer.actionProof round-trip', function () {

    const BLOCK = 200;
    // A representative block: ledger leaves (2 credits + 1 debit) precede the actions
    // leaves in the frozen §5.1 order, so the actions leaves land at indices 3,4,5.
    // Includes a tx_index-NULL synthetic action (ORDER_MATCH), which the block_merkle
    // tree covers exactly as the consensus hash does.
    const blockRows = {
        block_index: BLOCK,
        ledger: {
            credits: [{ action_index: 10, address: ADDR_A, tick: TICK, amount: '5' },
                      { action_index: 11, address: ADDR_Z, tick: TICK, amount: '3' }],
            debits:  [{ action_index: 11, address: ADDR_A, tick: TICK, amount: '3' }],
            escrows: []
        },
        actions: [
            { action_index: 10, tx_index: 100,  action: 'ISSUE' },
            { action_index: 11, tx_index: 101,  action: 'SEND' },
            { action_index: 12, tx_index: null, action: 'ORDER_MATCH' }
        ],
        contracts: { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] }
    };
    const BLOCK_MERKLE = M.toHex(M.blockMerkleRoot(M.blockMerkleLeaves(blockRows)));

    function makeActionServer() {
        const db = {
            async getActionBlockIndex(config, aix) {
                return blockRows.actions.some(a => a.action_index === Number(aix)) ? BLOCK : null;
            },
            async getCheckpointAt() {
                return { chain: CHAIN, network: NET, block_index: BLOCK, block_hash: 'c0'.repeat(32),
                    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                    checkpoint_seq: 0, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 1,
                    block_merkle_root: BLOCK_MERKLE, block_merkle_version: 1, validator_signatures: '[]' };
            },
            async getStateTreeRow() {
                return { balances_root: EMPTY_ROOT, stakes_root: EMPTY_ROOT, state_root: 'd4'.repeat(32), block_merkle_root: BLOCK_MERKLE };
            },
            async getBlockLeafRows() { return blockRows; },
            async getMaxBlockIndex() { return BLOCK; }
        };
        return new ProofServer(db);
    }

    it('an action inclusion proof verifies against the committed block_merkle_root', async function () {
        const server = makeActionServer();
        const r = await server.actionProof({ coin: COIN }, CHAIN, NET, 11);
        assert.ok(!r.error, 'no error: ' + r.error);
        const p = r.proof;
        assert.strictEqual(p.height, BLOCK);
        assert.strictEqual(p.action_index, 11);
        assert.strictEqual(p.action, 'SEND');
        assert.strictEqual(p.tx_index, 101);
        assert.strictEqual(p.block_merkle_root, BLOCK_MERKLE);
        // The committed leaf is exactly actionsLeaf(row), and the proof recomputes the root.
        const expectLeaf = M.toHex(M.actionsLeaf({ action_index: 11, tx_index: 101, action: 'SEND' }));
        assert.strictEqual(p.leaf, expectLeaf);
        assert.ok(M.verifyFixedMerkleProof(BLOCK_MERKLE, M.toBuf(p.leaf), p.merkle_proof.index, p.merkle_proof.siblings),
            'action inclusion proof must verify against block_merkle_root');
        // The proof index sits past the 3 ledger leaves (credit,credit,debit).
        assert.strictEqual(p.merkle_proof.index, 3 + 1);
    });

    it('proves a tx_index-NULL synthetic action (ORDER_MATCH)', async function () {
        const server = makeActionServer();
        const r = await server.actionProof({ coin: COIN }, CHAIN, NET, 12);
        assert.ok(!r.error, 'no error: ' + r.error);
        assert.strictEqual(r.proof.tx_index, null);
        assert.strictEqual(r.proof.action, 'ORDER_MATCH');
        const expectLeaf = M.toHex(M.actionsLeaf({ action_index: 12, tx_index: null, action: 'ORDER_MATCH' }));
        assert.strictEqual(r.proof.leaf, expectLeaf);
        assert.ok(M.verifyFixedMerkleProof(BLOCK_MERKLE, M.toBuf(r.proof.leaf), r.proof.merkle_proof.index, r.proof.merkle_proof.siblings));
    });

    it('returns ACTION_NOT_FOUND for an unknown action', async function () {
        const server = makeActionServer();
        const r = await server.actionProof({ coin: COIN }, CHAIN, NET, 999);
        assert.strictEqual(r.error, 'ACTION_NOT_FOUND');
    });

    it('returns ACTION_BLOCK_NOT_CHECKPOINTED when the block was never checkpointed', async function () {
        const server = makeActionServer();
        server.db.getCheckpointAt = async () => null;
        const r = await server.actionProof({ coin: COIN }, CHAIN, NET, 11);
        assert.strictEqual(r.error, 'ACTION_BLOCK_NOT_CHECKPOINTED');
    });

    it('refuses when the committed block_merkle_root disagrees with the local block tree', async function () {
        const server = makeActionServer();
        server.db.getCheckpointAt = async () => ({ chain: CHAIN, network: NET, block_index: BLOCK,
            checkpoint_seq: 0, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 1,
            block_merkle_root: 'ff'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' });
        const r = await server.actionProof({ coin: COIN }, CHAIN, NET, 11);
        assert.strictEqual(r.error, 'PROOF_BLOCK_MERKLE_MISMATCH');
    });
});

describe('SPV Phase 5: ProofServer.validatorSetProof round-trip', function () {

    const S = 100;                              // BTC snapshot height == BTC checkpoint block_index
    const CAP = 'oracle_publish';
    const PKA = 'aa'.repeat(32), PKB = 'bb'.repeat(32), PKC = 'cc'.repeat(32);
    // Source S1 has two pubkeys (weight 10 each); S2 one (30). Source-deduped total 40.
    const VALS = [{ pubkey: PKA, source: 'S1', weight: '10' },
                  { pubkey: PKB, source: 'S1', weight: '10' },
                  { pubkey: PKC, source: 'S2', weight: '30' }];

    function makeServer() {
        const entries = VALS.map(v => [ M.toHex(M.stakeKey(v.pubkey, CAP)), M.toHex(M.stakeMemberLeaf(v.source, v.weight)) ]);
        entries.push([ M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP)), M.toHex(M.stakeTotalLeaf('40')) ]);
        const built = buildStore(entries);
        const stakesRoot = built.root, balancesRoot = EMPTY_ROOT;
        const stateRoot  = M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot }));
        const db = {
            async getCheckpointAt() {
                return { chain: CHAIN, network: NET, block_index: S, block_hash: 'c0'.repeat(32),
                    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                    checkpoint_seq: 0, snapshot_block: S, state_root: stateRoot, state_root_version: 1,
                    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
            },
            async getStateTreeRow() { return { balances_root: balancesRoot, stakes_root: stakesRoot, state_root: stateRoot, block_merkle_root: 'e5'.repeat(32) }; },
            async getStateNode(config, h) { return built.nodes.get(h) || null; },
            async getMaxBlockIndex() { return S; }
        };
        const indexerConn = { async stakeWeights(cap) { return (cap === CAP) ? { capability: cap, validators: VALS } : { error: 'capability not configured' }; } };
        return { server: new ProofServer(db), stakesRoot, stateRoot, indexerConn };
    }

    it('proves each signer (source+weight) and the source-deduped total against stakes_root', async function () {
        const { server, stakesRoot, stateRoot, indexerConn } = makeServer();
        const r = await server.validatorSetProof({ coin: 'RBTC' }, 'BTC', NET, S, indexerConn);
        assert.ok(!r.error, 'no error: ' + r.error);
        const op = r.proof.capabilities[CAP];
        assert.strictEqual(op.total, M.canonicalAmount('40'));
        // every member proof verifies and its leaf commits exactly (source, weight)
        for (const v of op.validators) {
            const keyBuf = M.stakeKey(v.pubkey, CAP);
            assert.strictEqual(v.smt_proof.leaf_value, M.toHex(M.stakeMemberLeaf(v.source, v.weight)), 'member leaf preimage bind');
            assert.ok(M.verifyCompressedSmtProof(stakesRoot, keyBuf, v.smt_proof.leaf_value, v.smt_proof.compressed),
                'member proof must verify against stakes_root: ' + v.pubkey);
        }
        // the total proof verifies and commits 40
        assert.strictEqual(op.total_proof.leaf_value, M.toHex(M.stakeTotalLeaf('40')));
        assert.ok(M.verifyCompressedSmtProof(stakesRoot, M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP), op.total_proof.leaf_value, op.total_proof.compressed),
            'total proof must verify against stakes_root');
        // sub_root_path binds stakes_root into the committed state_root
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(r.proof.stakes_root), r.proof.sub_root_path.index, r.proof.sub_root_path.siblings),
            'sub_root_path must bind stakes_root into state_root');
    });

    it('rejects a non-BTC chain (stakes_root is BTC-only)', async function () {
        const { server, indexerConn } = makeServer();
        const r = await server.validatorSetProof({ coin: 'RLTC' }, 'LTC', NET, S, indexerConn);
        assert.strictEqual(r.error, 'STAKES_BTC_ONLY');
    });

    it('reports SNAPSHOT_NOT_YET_CHECKPOINTED when no BTC checkpoint exists at S', async function () {
        const { server, indexerConn } = makeServer();
        server.db.getCheckpointAt = async () => null;
        const r = await server.validatorSetProof({ coin: 'RBTC' }, 'BTC', NET, S, indexerConn);
        assert.strictEqual(r.error, 'SNAPSHOT_NOT_YET_CHECKPOINTED');
    });
});
