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
 * SPV light-client proof server (Phase 3, spec §8.1).
 *
 * Builds the read-only Merkle proofs a light client verifies locally against a
 * quorum-signed checkpoint's committed state_root. All crypto comes from the
 * byte-identical merkle.js twin (the same module the indexer commits with and the
 * SDK verifies with), so a proof produced here verifies under
 * merkle.verifyCompressedSmtProof + the §4.4 sub_root_path check.
 *
 * The SMT proof walk descends the indexer's content-addressed node store
 * (state_tree_nodes) from a historical balances/stakes sub-root: a port of
 * stateCommitment.PersistentSMT._descend, reading one internal node per level
 * (empty subtrees short-circuit, so a sparse path is far cheaper than 256 reads).
 * state_tree_nodes is NOT replicated by xchain-sync, so the server MUST point at a
 * full indexer DB; a thin replica cannot serve proofs (the caller surfaces that).
 *
 ********************************************************************/

'use strict';

const M = require('./merkle.js');

const EMPTY0_HEX = M.toHex(M.EMPTY[0]);

class ProofServer {
    constructor(db) { this.db = db; }

    // Descend a key's path through the persistent node store as-of `rootHex`,
    // collecting the 256 siblings (top-down). Mirrors PersistentSMT._descend.
    async _descend(config, rootHex, keyBuf) {
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex;
        let empty = false;
        for (let d = 0; d < M.SMT_DEPTH; d++) {
            const sibEmptyHex = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if (empty) { siblings[d] = sibEmptyHex; continue; }
            const row = await this.db.getStateNode(config, cur);
            if (!row) { empty = true; siblings[d] = sibEmptyHex; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return { siblings, oldLeaf: empty ? EMPTY0_HEX : cur };
    }

    // Membership / non-membership proof for keyBuf as-of rootHex. Same shape as
    // merkle.SparseMerkleTree.prove / PersistentSMT.prove (verify with
    // M.verifyCompressedSmtProof). leaf_value null => non-inclusion (zero).
    async _prove(config, rootHex, keyBuf) {
        const { siblings, oldLeaf } = await this._descend(config, rootHex, keyBuf);
        const present = (oldLeaf !== EMPTY0_HEX);
        return {
            key:        M.toHex(keyBuf),
            leaf_value: present ? oldLeaf : null,
            siblings,
            compressed: M.compressSmtProof(siblings)
        };
    }

    // Shape a checkpoint row for the response: keep the signed fields + parse the
    // validator_signatures JSON so a client can re-verify quorum locally.
    _shapeCheckpoint(cp) {
        let sigs = [];
        try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch (e) { sigs = []; }
        return {
            chain: cp.chain, network: cp.network, block_index: Number(cp.block_index),
            block_hash: cp.block_hash, ledger_hash: cp.ledger_hash, actions_hash: cp.actions_hash,
            contract_hash: cp.contract_hash, checkpoint_seq: Number(cp.checkpoint_seq),
            snapshot_block: Number(cp.snapshot_block),
            state_root: cp.state_root, state_root_version: cp.state_root_version,
            block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version,
            validator_signatures: sigs
        };
    }

    // Bind a per-block sub-root set to the signed checkpoint: the indexer's
    // state_tree_roots row at the checkpoint height must reassemble to the signed
    // state_root, else the indexer DB and the signed checkpoint disagree (a server
    // bug / divergence) and we refuse to serve a proof a client could not bind.
    _bindRoots(cp, tr) {
        const assembled = M.toHex(M.stateRoot({ balances_root: tr.balances_root, stakes_root: tr.stakes_root }));
        if (cp.state_root && String(cp.state_root).toLowerCase() !== assembled)
            throw new Error('PROOF_STATE_ROOT_MISMATCH');
        return assembled;
    }

    // GET /:coin/api/proof/balance/:address/:tick?height=H  (spec §4.4 / §8.1)
    // Returns { proof: BalanceProof, checkpoint } or a typed error object.
    async balanceProof(config, chain, network, address, tick, height) {
        const cp = await this.db.getCheckpointAtOrAbove(config, height);
        if (!cp) return { error: 'NO_CHECKPOINT' };
        if (cp.state_root == null) return { error: 'CHECKPOINT_PRE_COMMITMENT' };  // pre-flag-day checkpoint
        const tr = await this.db.getStateTreeRow(config, cp.block_index);
        if (!tr) return { error: 'NO_STATE_TREE' };                                // not a full indexer DB
        let stateRoot;
        try { stateRoot = this._bindRoots(cp, tr); }
        catch (e) { return { error: (e && e.message) || 'PROOF_STATE_ROOT_MISMATCH' }; }
        const keyBuf = M.balanceKey(chain, network, address, tick);
        const smt    = await this._prove(config, tr.balances_root, keyBuf);
        const sub    = M.stateRootProof({ balances_root: tr.balances_root, stakes_root: tr.stakes_root }, 'balances_root');
        // Authoritative amount (never the balances cache). Non-inclusion => "0".
        const amount = (smt.leaf_value == null)
            ? M.canonicalAmount('0')
            : M.canonicalAmount(await this.db.getNetBalance18(config, address, tick));
        return {
            proof: {
                chain, network, height: Number(cp.block_index), address, tick, amount,
                smt_proof: { key: smt.key, leaf_value: smt.leaf_value, compressed: smt.compressed },
                sub_root_path: { index: sub.index, siblings: sub.siblings },
                balances_root: tr.balances_root, stakes_root: tr.stakes_root,
                state_root: cp.state_root || stateRoot, state_root_version: cp.state_root_version
            },
            checkpoint: this._shapeCheckpoint(cp)
        };
    }

    // GET /:coin/api/checkpoints/range?from=&to=  (spec §8.1, forward-following)
    async checkpointRange(config, fromH, toH, limit) {
        const rows = await this.db.getCheckpointRange(config, fromH, toH, limit);
        return { checkpoints: (rows || []).map(r => this._shapeCheckpoint(r)), count: (rows || []).length };
    }
}

module.exports = ProofServer;
