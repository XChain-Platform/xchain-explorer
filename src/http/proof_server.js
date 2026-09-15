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

const M   = require('../consensus/merkle.js');
// The six proof builders live in proof_server/proofs.js and are installed onto
// the class below.
const ProofBuilders = require('./proof_server/proofs.js');
// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('../observability');
const log = getLogger();
// Every environment read goes through config.js's live read-through view of
// process.env, so config.js stays the one place the gate lets env be read. The
// view is looked up per read so that requiring this module never loads config.js,
// whose SSL probe and log line would otherwise run in every tool and suite that
// never reads a variable.
const configEnv = () => require('../config.js').env;

const EMPTY0_HEX = M.toHex(M.EMPTY[0]);

// Reserved state_root slots that have a persisted column on state_tree_roots, in
// no particular order (merkle.stateRoot places each by NAME, not by iteration
// order). Derived from the frozen slot list rather than written out, so a slot
// added to merkle.STATE_SUBTREES cannot be silently missed here; a slot with no
// column simply never appears on a row and is skipped.
const EXTENSION_SLOTS = M.STATE_SUBTREES.slice(2);

class ProofServer {
    constructor(db) {
        this.db = db;
        // Advisory staleness bound (blocks) used to flag a proof's checkpoint as `stale`.
        // The raw chain_tip + lag are always returned; this only sets the convenience flag.
        this.staleLagBlocks = Number(configEnv().SPV_CHECKPOINT_MAX_LAG_BLOCKS) || 100;
    }

    // Descend a key's path through the persistent node store as-of `rootHex`,
    // collecting the 256 siblings (top-down). Mirrors PersistentSMT._descend.
    async descend(config, rootHex, keyBuf) {
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
    async prove(config, rootHex, keyBuf) {
        const { siblings, oldLeaf } = await this.descend(config, rootHex, keyBuf);
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
    shapeCheckpoint(cp, chainTip) {
        let sigs = [];
        // Rows may arrive pre-parsed (db.normalizeCheckpointRows now emits an
        // array) or raw from a direct query; accept both.
        if (Array.isArray(cp.validator_signatures)) {
            sigs = cp.validator_signatures;
        } else try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch (e) {
            log.warn('PROOF_CHECKPOINT_SIGNATURES_MALFORMED', {
                checkpoint_seq: cp.checkpoint_seq, err: e.message, detail: 'shaping response with empty signature set'
            });
            sigs = [];
        }
        // Indices are emitted as decimal STRINGS, matching every other index on the
        // explorer's REST/WS surface (jsonStringify + ws/serialize.js stringify BigInt).
        // The canonical signing string String()s them, so verification bytes are unchanged.
        let shaped = {
            chain: cp.chain, network: cp.network, block_index: String(cp.block_index),
            block_hash: cp.block_hash, ledger_hash: cp.ledger_hash, actions_hash: cp.actions_hash,
            contract_hash: cp.contract_hash, checkpoint_seq: String(cp.checkpoint_seq),
            snapshot_block: String(cp.snapshot_block),
            state_root: cp.state_root, state_root_version: cp.state_root_version,
            block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version,
            validator_signatures: sigs
        };
        // Advisory freshness: how far this signed checkpoint trails the indexer's chain
        // tip. SPV clients must still verify freshness against their own header chain (a
        // server cannot be trusted to report its own staleness); chain_tip + lag are
        // diagnostic and `stale` is a convenience flag past SPV_CHECKPOINT_MAX_LAG_BLOCKS.
        if (chainTip != null && Number.isFinite(Number(chainTip))) {
            let tip = Number(chainTip);
            let lag = Math.max(0, tip - Number(cp.block_index));
            shaped.chain_tip = tip;
            shaped.lag       = lag;
            shaped.stale     = lag > this.staleLagBlocks;
        }
        return shaped;
    }

    // The sub-root set a stored row commits, INCLUDING any armed extension slots.
    // One helper, used by every reassembly and every sub_root_path here, so a slot
    // can never be present in the binding check and absent from the proof path.
    //
    // NO ACTIVATION-HEIGHT GATE, deliberately, and this is the one design call in
    // the explorer's read path worth understanding. The indexer writes these
    // columns FROM the gated value: NULL whenever the slot was inert at that
    // height, the real sub-root whenever it was armed. So the row already carries
    // the gate's decision for its own height, and reading "non-NULL means
    // committed" is exactly equivalent to re-deriving the gate, minus a second
    // copy of the activation map that could drift from the indexer's on a
    // half-deployed fleet. A drifted map would fail LOUDLY here
    // (PROOF_STATE_ROOT_MISMATCH on every proof at that height), but loud is still
    // an outage, and the outage would be caused solely by the duplicate.
    //
    // The constraint this accepts in exchange: nothing may write these columns for
    // a height at which the slot was NOT committed. In particular a shadow-compute
    // window must persist its candidate somewhere else, not here (spec §7).
    subRoots(tr) {
        const subRoots = { balances_root: tr.balances_root, stakes_root: tr.stakes_root };
        for (const slot of EXTENSION_SLOTS)
            if (tr[slot]) subRoots[slot] = tr[slot];
        return subRoots;
    }

    // Bind a per-block sub-root set to the signed checkpoint: the indexer's
    // state_tree_roots row at the checkpoint height must reassemble to the signed
    // state_root, else the indexer DB and the signed checkpoint disagree (a server
    // bug / divergence) and we refuse to serve a proof a client could not bind.
    bindRoots(cp, tr) {
        const assembled = M.toHex(M.stateRoot(this.subRoots(tr)));
        if (cp.state_root && String(cp.state_root).toLowerCase() !== assembled)
            throw new Error('PROOF_STATE_ROOT_MISMATCH');
        return assembled;
    }
}

// Copy each part's methods onto the class prototype by descriptor, so they stay
// non-enumerable exactly as methods written in the class body are, and refuse a
// name the class already defines: a split must never silently shadow a method.
function installParts(target, parts) {
    for (const part of parts) {
        for (const name of Object.getOwnPropertyNames(part.prototype)) {
            if (name === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(target.prototype, name))
                throw new Error(target.name + ': part method ' + name + ' collides with an existing method');
            Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
        }
    }
}

installParts(ProofServer, [ProofBuilders]);

module.exports = ProofServer;
