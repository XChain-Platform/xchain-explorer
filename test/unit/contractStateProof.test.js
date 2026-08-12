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
 * Contract-state proofs and the two-root reassembly.
 *
 * The most valuable test in this file is not the new endpoint: it is
 * "balance and stakes proofs still serve at a height where contract_state_root is
 * populated". Before this change the explorer reassembled state_root from exactly
 * two stored roots and refused to serve on mismatch, so the moment the slot became
 * real EVERY balance and stakes proof at an armed height would have failed with
 * PROOF_STATE_ROOT_MISMATCH. Loud, but a total proof outage, and it would have
 * arrived with the arming flag day rather than with this code.
 *
 * The second-most valuable is the REFUSAL: below an armed height the slot commits
 * EMPTY_SMT_ROOT, against which a non-membership proof for any key verifies
 * perfectly and means nothing. Serving that as "no such key" would let a client
 * conclude a key is absent from a commitment that never covered contract state.
 * The endpoint returns a typed CONTRACT_STATE_NOT_COMMITTED instead.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const M      = require('../../src/merkle.js');
const ProofServer = require('../../src/proofServer.js');
const XChainExplorer = require('../../src/XChainExplorer.js');

const EMPTY_ROOT = M.toHex(M.EMPTY_SMT_ROOT);
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);

// Minimal in-memory SMT builder over the same primitives the indexer commits with.
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
const CIDX   = 7;
const KEY    = 'counter';
const VALUE  = '"42"';                       // JSON.stringify'd, exactly as the VM stores it

// A venue where the contract-state slot is ARMED: the row carries a real
// contract_state_root and the checkpoint's state_root was assembled WITH it.
function makeArmed(opts) {
    opts = opts || {};
    const balancesRoot = buildStore([[M.toHex(M.balanceKey(CHAIN, NET, '1Addr', 'XCHAIN')),
                                      M.toHex(M.amountLeaf('5'))]]);
    const contract = buildStore([[M.toHex(M.contractStateKey(CHAIN, NET, CIDX, KEY)),
                                  M.toHex(M.leafHash(VALUE))]]);
    const stakesRoot = EMPTY_ROOT;
    const subRoots = { balances_root: balancesRoot.root, stakes_root: stakesRoot };
    if (!opts.checkpointOmitsSlot) subRoots.contract_state_root = contract.root;
    const stateRoot = M.toHex(M.stateRoot(subRoots));

    const nodes = new Map([...balancesRoot.nodes, ...contract.nodes]);
    const db = {
        async getCheckpointAtOrAbove() {
            return { chain: CHAIN, network: NET, block_index: HEIGHT, block_hash: 'c0'.repeat(32),
                ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                checkpoint_seq: 0, snapshot_block: HEIGHT, state_root: stateRoot, state_root_version: 2,
                block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
        },
        async getStateTreeRow() {
            return { balances_root: balancesRoot.root, stakes_root: stakesRoot, state_root: stateRoot,
                     block_merkle_root: 'e5'.repeat(32),
                     contract_state_root: opts.rowOmitsSlot ? null : contract.root };
        },
        async getStateNode(config, nodeHash) { return nodes.get(nodeHash) || null; },
        async getContractStateValueAtHeight() { return VALUE; },
        async getNetBalance18AtHeight() { return '5.000000000000000000'; },
        async getMaxBlockIndex() { return HEIGHT; }
    };
    return { server: new ProofServer(db), stateRoot, contractRoot: contract.root,
             balancesRoot: balancesRoot.root, stakesRoot };
}

// A venue where the slot is INERT: the column is NULL and state_root is the plain
// v1 two-root assembly, exactly as every chain looks today.
function makeInert() {
    const balances = buildStore([[M.toHex(M.balanceKey(CHAIN, NET, '1Addr', 'XCHAIN')),
                                  M.toHex(M.amountLeaf('5'))]]);
    const stateRoot = M.toHex(M.stateRoot({ balances_root: balances.root, stakes_root: EMPTY_ROOT }));
    const db = {
        async getCheckpointAtOrAbove() {
            return { chain: CHAIN, network: NET, block_index: HEIGHT, block_hash: 'c0'.repeat(32),
                ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                checkpoint_seq: 0, snapshot_block: HEIGHT, state_root: stateRoot, state_root_version: 1,
                block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: '[]' };
        },
        async getStateTreeRow() {
            return { balances_root: balances.root, stakes_root: EMPTY_ROOT, state_root: stateRoot,
                     block_merkle_root: 'e5'.repeat(32), contract_state_root: null };
        },
        async getStateNode(config, nodeHash) { return balances.nodes.get(nodeHash) || null; },
        async getNetBalance18AtHeight() { return '5.000000000000000000'; },
        async getMaxBlockIndex() { return HEIGHT; }
    };
    return { server: new ProofServer(db), stateRoot, balancesRoot: balances.root };
}

describe('SPV Stage A: existing proofs survive an armed contract_state_root @regression', function () {

    it('a balance proof still serves and still binds at an armed height', async function () {
        // THE regression this stage exists to avoid. With a two-root reassembly this
        // returns PROOF_STATE_ROOT_MISMATCH for every address on the chain.
        const { server, stateRoot, balancesRoot } = makeArmed();
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, '1Addr', 'XCHAIN', HEIGHT);
        assert.ok(!r.error, 'balance proof must still serve: ' + r.error);
        assert.strictEqual(r.proof.state_root, stateRoot);
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(balancesRoot),
                                           r.proof.sub_root_path.index, r.proof.sub_root_path.siblings),
            'sub_root_path must still bind balances_root into the armed state_root');
    });

    it('the inert chain is completely unaffected (NULL column, v1 assembly)', async function () {
        const { server, stateRoot, balancesRoot } = makeInert();
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, '1Addr', 'XCHAIN', HEIGHT);
        assert.ok(!r.error, 'inert balance proof must serve: ' + r.error);
        assert.strictEqual(r.proof.state_root, stateRoot);
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(balancesRoot),
                                           r.proof.sub_root_path.index, r.proof.sub_root_path.siblings));
    });

    it('a row that omits a slot the checkpoint committed is refused, not served', async function () {
        // Deploy skew in the dangerous direction: the signed checkpoint covers the
        // extension slot but the local row does not carry it. Reassembly must fail
        // rather than serve a proof bound to a state_root nobody signed.
        const { server } = makeArmed({ rowOmitsSlot: true });
        const r = await server.balanceProof({ coin: COIN }, CHAIN, NET, '1Addr', 'XCHAIN', HEIGHT);
        assert.strictEqual(r.error, 'PROOF_STATE_ROOT_MISMATCH');
    });
});

describe('SPV Stage A: contractStateProof @regression', function () {

    it('a membership proof verifies and binds into the signed state_root', async function () {
        const { server, stateRoot, contractRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        assert.ok(!r.error, 'no error: ' + r.error);
        const p = r.proof;
        // 1. The SMT proof recomputes contract_state_root from (key, leaf, siblings).
        const keyBuf = M.contractStateKey(CHAIN, NET, CIDX, KEY);
        assert.ok(M.verifyCompressedSmtProof(contractRoot, keyBuf, p.smt_proof.leaf_value, p.smt_proof.compressed),
            'SMT membership proof must verify against contract_state_root');
        // 2. The committed leaf is exactly leafHash(RAW stored value), which is what
        //    lets a client check the value it was handed.
        assert.strictEqual(p.smt_proof.leaf_value, M.toHex(M.leafHash(VALUE)));
        assert.strictEqual(p.state_value, VALUE);
        // 3. sub_root_path binds contract_state_root into the signed state_root.
        assert.ok(M.verifyFixedMerkleProof(stateRoot, M.toBuf(p.contract_state_root),
                                           p.sub_root_path.index, p.sub_root_path.siblings),
            'sub_root_path must bind contract_state_root into state_root');
        // 4. The exact key bytes proven are echoed back.
        assert.strictEqual(p.state_key, KEY);
        assert.strictEqual(p.contract_index, String(CIDX));
    });

    it('an absent key at an armed height is a verifiable non-inclusion proof', async function () {
        const { server, contractRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, 'no-such-key', HEIGHT);
        assert.ok(!r.error, 'no error: ' + r.error);
        assert.strictEqual(r.proof.smt_proof.leaf_value, null);
        assert.strictEqual(r.proof.state_value, null, 'no leaf means no preimage to serve');
        assert.ok(M.verifyCompressedSmtProof(contractRoot, M.contractStateKey(CHAIN, NET, CIDX, 'no-such-key'),
                                             null, r.proof.smt_proof.compressed),
            'non-inclusion must verify against the armed contract_state_root');
    });

    it('REFUSES below an armed height instead of proving absence against an EMPTY tree', async function () {
        const { server } = makeInert();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        assert.strictEqual(r.error, 'CONTRACT_STATE_NOT_COMMITTED');
    });

    it('a different contract index proves a different key (no cross-contract smear)', async function () {
        const { server } = makeArmed();
        const same  = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        const other = await server.contractStateProof({ coin: COIN }, CHAIN, NET, 8, KEY, HEIGHT);
        assert.notStrictEqual(other.proof.smt_proof.key, same.proof.smt_proof.key);
        assert.strictEqual(other.proof.smt_proof.leaf_value, null, 'contract 8 wrote nothing');
    });
});

describe('SPV Stage A: contractStateProof verifies through the real SDK verifier @regression', function () {

    // Strongest available check short of a live venue: the server's actual response
    // is fed to the SDK's client-side verifier, so the two independent
    // implementations of "what does this proof mean" have to agree. Skipped rather
    // than failed when the sibling repo is absent (standalone checkout).
    let light = null;
    try { light = require('../../../xchain-sdk/src/light.js'); } catch (e) { light = null; }

    it('a membership proof verifies and yields the raw stored value', async function () {
        if (!light) return this.skip();
        const { server, stateRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        const v = light.verifyContractStateProof(r.proof, stateRoot, CHAIN, NET);
        assert.strictEqual(v.reason, null);
        assert.strictEqual(v.verified, true);
        assert.strictEqual(v.state_value, VALUE, 'the RAW stored string, not the parsed form');
        assert.strictEqual(JSON.parse(v.state_value), '42', 'callers parse AFTER verifying');
    });

    it('a non-inclusion proof verifies as "not in the committed tree"', async function () {
        if (!light) return this.skip();
        const { server, stateRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, 'absent', HEIGHT);
        const v = light.verifyContractStateProof(r.proof, stateRoot, CHAIN, NET);
        assert.strictEqual(v.verified, true);
        assert.strictEqual(v.state_value, null);
    });

    it('rejects a proof whose key does not match the requested identity', async function () {
        if (!light) return this.skip();
        const { server, stateRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        // Same proof, re-labelled as a different contract: the key no longer derives.
        const tampered = Object.assign({}, r.proof, { contract_index: '8' });
        assert.strictEqual(light.verifyContractStateProof(tampered, stateRoot, CHAIN, NET).reason, 'KEY_MISMATCH');
        // And re-labelled onto another chain, which is why chain/network come from
        // the trusted checkpoint rather than from the proof body.
        assert.strictEqual(light.verifyContractStateProof(r.proof, stateRoot, 'LTC', NET).reason, 'KEY_MISMATCH');
    });

    it('rejects a value that does not preimage the committed leaf', async function () {
        if (!light) return this.skip();
        const { server, stateRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        const lying = Object.assign({}, r.proof, { state_value: '"9999"' });
        assert.strictEqual(light.verifyContractStateProof(lying, stateRoot, CHAIN, NET).reason, 'LEAF_VALUE_MISMATCH');
    });

    it('rejects a proof bound against the wrong sub-root slot', async function () {
        if (!light) return this.skip();
        // The attack the slot pin exists for: slots 2 and 3 are constant EMPTY, so a
        // path built for one of them would let a server "prove" any key absent.
        const { server, stateRoot } = makeArmed();
        const r = await server.contractStateProof({ coin: COIN }, CHAIN, NET, CIDX, KEY, HEIGHT);
        const moved = Object.assign({}, r.proof, {
            sub_root_path: { index: M.STATE_SUBTREES.indexOf('tokens_root'), siblings: r.proof.sub_root_path.siblings }
        });
        assert.strictEqual(light.verifyContractStateProof(moved, stateRoot, CHAIN, NET).reason, 'SUBROOT_SLOT_MISMATCH');
    });
});

describe('SPV Stage A: contract-state request validation @regression', function () {

    // The handler is exercised directly: every rule below must run BEFORE the key
    // reaches merkle.joinFields (which throws on 0x00) or decodeURIComponent, so a
    // hostile path segment gets a typed 400 and never a 500 or a crash.
    function runHandler(params, query) {
        const captured = {};
        const res = {
            status(code){ captured.code = code; return this; },
            json(body){ captured.body = body; return this; }
        };
        const self = {
            db: { pools: { [COIN]: {} } },
            _mirrorGate: () => ({ blocked: null }),
            parseCoinCode: () => ({ coin: CHAIN, network: NET }),
            configInfo: { getConfig: async () => ({}) },
            proofServer: { contractStateProof: async (cfg, chain, net, idx, key) => {
                captured.reachedServer = true;
                captured.serverKey = key;          // what the handler actually proves over
                return { proof: {}, checkpoint: {} };
            } }
        };
        const req = { params: Object.assign({ coin: COIN }, params), query: query || {} };
        return XChainExplorer.prototype.processContractStateProofRequest.call(self, req, res)
            .then(() => captured);
    }

    it('rejects a NUL byte in the key with a 400, never letting it reach joinFields', async function () {
        // joinFields THROWS on 0x00 to keep the field join injective. Unguarded, an
        // unauthenticated `%00` request would surface as a 500 from a throwing
        // crypto primitive.
        const out = await runHandler({ contractIndex: '7', key: 'a\u0000b' });
        assert.strictEqual(out.code, 400);
        assert.strictEqual(out.body.code, 'INVALID_KEY_NUL');
        assert.ok(!out.reachedServer, 'the key must not reach the proof server');
        // And the primitive really does throw, so the guard is load-bearing.
        assert.throws(() => M.contractStateKey(CHAIN, NET, 7, 'a\u0000b'), /0x00/);
    });

    it('forwards a percent-bearing key BYTE FOR BYTE, never decoding what Express already decoded', async function () {
        // Express decodes :key before the handler runs, so a second decode here
        // silently answers for a different key than the client asked about. Driven
        // on the live service 2026-08-06: `/proof/contract-state/6/100%25` (the key
        // `100%`) returned 400 INVALID_KEY_ENCODING, and `a%2541b` (the key `a%41b`)
        // was proved as `aAb`. The SDK cannot catch that substitution, because
        // verifyContractStateProof re-derives its key from the ECHOED state_key.
        //
        // These params are what Express hands over, i.e. already once-decoded.
        const hex = await runHandler({ contractIndex: '7', key: 'a%41b' });
        assert.ok(hex.reachedServer, 'a legitimate key must reach the proof server');
        assert.strictEqual(hex.serverKey, 'a%41b', 'the key must not be decoded a second time');

        assert.notStrictEqual(hex.body && hex.body.code, 'INVALID_KEY_ENCODING');
    });

    it('serves a key ending in a bare percent, which used to throw and 400', async function () {
        // Kept separate from the case above so each fails on its own: a single test
        // asserting both only ever reports the first, which hides half the guard.
        // `100%` is what Express hands over for the request `100%25`; the retired
        // decode threw URIError on it and answered INVALID_KEY_ENCODING, measured on
        // the live service 2026-08-06.
        const out = await runHandler({ contractIndex: '7', key: '100%' });
        assert.ok(out.reachedServer, 'a key ending in `%` is legitimate and must be served');
        assert.strictEqual(out.serverKey, '100%');
        assert.notStrictEqual(out.code, 400);
        assert.notStrictEqual(out.body && out.body.code, 'INVALID_KEY_ENCODING');
    });

    it('still forwards an ordinary key unchanged', async function () {
        const out = await runHandler({ contractIndex: '7', key: 'seed/bulk/27' });
        assert.ok(out.reachedServer);
        assert.strictEqual(out.serverKey, 'seed/bulk/27');
    });

    it('rejects an over-cap key with a 400 (mirrors the VM maxStateKeySize)', async function () {
        const out = await runHandler({ contractIndex: '7', key: 'k'.repeat(1025) });
        assert.strictEqual(out.code, 400);
        assert.strictEqual(out.body.code, 'KEY_TOO_LONG');
        assert.ok(!out.reachedServer);
        // The cap is on BYTES, not characters: a 600-char multi-byte key is over it.
        const wide = await runHandler({ contractIndex: '7', key: 'é'.repeat(600) });
        assert.strictEqual(wide.body.code, 'KEY_TOO_LONG');
    });

    it('rejects a non-integer contract index and a non-integer height', async function () {
        const bad = await runHandler({ contractIndex: '7abc', key: 'k' });
        assert.strictEqual(bad.body.code, 'INVALID_CONTRACT_INDEX');
        const h = await runHandler({ contractIndex: '7', key: 'k' }, { height: '1e3' });
        assert.strictEqual(h.body.code, 'INVALID_HEIGHT');
    });

    it('accepts an ordinary key and reaches the proof server', async function () {
        // Guard against a validator so strict it rejects everything.
        const out = await runHandler({ contractIndex: '7', key: 'counter' });
        assert.ok(out.reachedServer, 'a well-formed request must reach the proof server');
    });
});
