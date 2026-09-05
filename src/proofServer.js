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

const M   = require('./merkle.js');
const SUB = require('./state_subtree_activation.js');   // byte-identical fourth carrier; escrow-leaf liveness only
const swq = require('./stake_weighted_quorum.js');

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
        this.staleLagBlocks = Number(process.env.SPV_CHECKPOINT_MAX_LAG_BLOCKS) || 100;
    }

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
    _shapeCheckpoint(cp, chainTip) {
        let sigs = [];
        // Rows may arrive pre-parsed (db._normalizeCheckpointRows now emits an
        // array) or raw from a direct query; accept both.
        if (Array.isArray(cp.validator_signatures)) {
            sigs = cp.validator_signatures;
        } else try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch (e) {
            console.warn('[proofServer] malformed validator_signatures for checkpoint_seq ' +
                          cp.checkpoint_seq + '; shaping response with empty signature set:', e.message);
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
    _subRoots(tr) {
        const subRoots = { balances_root: tr.balances_root, stakes_root: tr.stakes_root };
        for (const slot of EXTENSION_SLOTS)
            if (tr[slot]) subRoots[slot] = tr[slot];
        return subRoots;
    }

    // Bind a per-block sub-root set to the signed checkpoint: the indexer's
    // state_tree_roots row at the checkpoint height must reassemble to the signed
    // state_root, else the indexer DB and the signed checkpoint disagree (a server
    // bug / divergence) and we refuse to serve a proof a client could not bind.
    _bindRoots(cp, tr) {
        const assembled = M.toHex(M.stateRoot(this._subRoots(tr)));
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
        const sub    = M.stateRootProof(this._subRoots(tr), 'balances_root');
        // Authoritative amount (never the balances cache). Non-inclusion => "0".
        // Height-bounded to cp.block_index (the SAME row getStateTreeRow committed
        // the leaf from), NOT the current tip: the SDK verifier requires
        // amountLeaf(amount) to preimage the checkpoint-height leaf, so a tip-net
        // balance would false-reject any address that moved after the checkpoint.
        const amount = (smt.leaf_value == null)
            ? M.canonicalAmount('0')
            : M.canonicalAmount(await this.db.getNetBalance18AtHeight(config, address, tick, cp.block_index));
        const tip = await this.db.getMaxBlockIndex(config);
        return {
            proof: {
                chain, network, height: Number(cp.block_index), address, tick, amount,
                smt_proof: { key: smt.key, leaf_value: smt.leaf_value, compressed: smt.compressed },
                sub_root_path: { index: sub.index, siblings: sub.siblings },
                balances_root: tr.balances_root, stakes_root: tr.stakes_root,
                state_root: cp.state_root || stateRoot, state_root_version: cp.state_root_version
            },
            checkpoint: this._shapeCheckpoint(cp, tip)
        };
    }

    // GET /:coin/api/proof/locked-balance/:address/:tick?height=H
    // (SPV sub-tree spec §3 Stage B)
    //
    // Proves the XCHAIN_ESC locked-balance leaf for (address, tick): the second
    // leaf domain inside the SAME balances_root the spendable proof binds, under
    // escrowKey()'s domain tag, so the sub_root_path pins the balances_root slot
    // exactly as balanceProof does and the response shape is identical. The two
    // domains cannot be confused by a verifier: each derives its own key, so a
    // locked proof fed to the spendable verifier (or vice versa) fails
    // KEY_MISMATCH rather than verifying as the other.
    //
    // BELOW THE ARMED HEIGHT THIS REFUSES rather than proving absence, for the
    // §4 reason contractStateProof does: against a balances_root that never
    // covered the ESC domain, a non-membership proof for any escrow key verifies
    // perfectly and means nothing. Unlike contract state, the refusal CANNOT be
    // read off the stored row (there is no ESC column; an ESC-covered root is
    // byte-indistinguishable from a v1 root when nothing is locked), so this is
    // the one explorer read that consults the vendored activation carrier. The
    // SDK verifier re-enforces the same rule with its OWN copy of the maps, so
    // this server-side refusal is defense-in-depth for naive clients, not the
    // trust boundary.
    async lockedBalanceProof(config, chain, network, address, tick, height) {
        const cp = await this.db.getCheckpointAtOrAbove(config, height);
        if (!cp) return { error: 'NO_CHECKPOINT' };
        if (cp.state_root == null) return { error: 'CHECKPOINT_PRE_COMMITMENT' };
        if (!SUB.isEscrowLockedLeafActive(Number(cp.block_index), network, chain))
            return { error: 'ESCROW_LEAF_NOT_COMMITTED' };
        const tr = await this.db.getStateTreeRow(config, cp.block_index);
        if (!tr) return { error: 'NO_STATE_TREE' };
        let stateRoot;
        try { stateRoot = this._bindRoots(cp, tr); }
        catch (e) { return { error: (e && e.message) || 'PROOF_STATE_ROOT_MISMATCH' }; }
        const keyBuf = M.escrowKey(chain, network, address, tick);
        const smt    = await this._prove(config, tr.balances_root, keyBuf);
        const sub    = M.stateRootProof(this._subRoots(tr), 'balances_root');
        // Preimage AS-OF the checkpoint height from the journal (latest row at or
        // below it; append-only, so exact). Non-inclusion means ZERO LOCKED, and
        // at an armed height that is a real claim (delete-on-zero: released and
        // never-locked keys both have no leaf), unlike below the armed height,
        // where this method refuses instead of pretending the tree answers.
        const amount = (smt.leaf_value == null)
            ? M.canonicalAmount('0')
            : M.canonicalAmount(await this.db.getLockedAmountAtHeight(config, address, tick, cp.block_index));
        const tip = await this.db.getMaxBlockIndex(config);
        return {
            proof: {
                chain, network, height: Number(cp.block_index), address, tick, amount,
                smt_proof: { key: smt.key, leaf_value: smt.leaf_value, compressed: smt.compressed },
                sub_root_path: { index: sub.index, siblings: sub.siblings },
                balances_root: tr.balances_root, stakes_root: tr.stakes_root,
                state_root: cp.state_root || stateRoot, state_root_version: cp.state_root_version
            },
            checkpoint: this._shapeCheckpoint(cp, tip)
        };
    }

    // GET /:coin/api/proof/action/:actionIndex  (spec §5 / §8.1)
    // A per-row block-content inclusion proof for the action's row, bound to the
    // checkpoint that commits THAT block's block_merkle_root. block_merkle_root is
    // per-block, so the action's block must itself be checkpointed (D3: checkpointed
    // heights only); a non-checkpointed block returns ACTION_BLOCK_NOT_CHECKPOINTED.
    // The client recomputes the root from the leaf + siblings (merkle.verifyFixedMerkleProof)
    // and requires it to equal the checkpoint's committed block_merkle_root.
    async actionProof(config, chain, network, actionIndex) {
        const blockIndex = await this.db.getActionBlockIndex(config, actionIndex);
        if (blockIndex == null) return { error: 'ACTION_NOT_FOUND' };
        const cp = await this.db.getCheckpointAt(config, blockIndex);
        if (!cp) return { error: 'ACTION_BLOCK_NOT_CHECKPOINTED' };
        if (cp.block_merkle_root == null) return { error: 'CHECKPOINT_PRE_COMMITMENT' };  // pre-flag-day
        const tr = await this.db.getStateTreeRow(config, blockIndex);
        if (!tr || tr.block_merkle_root == null) return { error: 'NO_STATE_TREE' };        // not a full indexer DB

        // Reassemble the block's ordered leaf vector with the twin-guarded ordering
        // (the same merkle.blockMerkleLeaves the indexer committed with), then locate
        // the target action's leaf: the actions leaves follow all ledger leaves in §5.1
        // order, so its index is (ledger leaf count) + (its position in the actions set).
        const rows = await this.db.getBlockLeafRows(config, blockIndex);
        const leaves = M.blockMerkleLeaves(rows);
        const aix = Number(actionIndex);
        const actionPos = (rows.actions || []).findIndex(r => Number(r.action_index) === aix);
        if (actionPos < 0) return { error: 'ACTION_LEAF_NOT_FOUND' };
        const ledgerCount = ['credits', 'debits', 'escrows']
            .reduce((n, k) => n + ((rows.ledger && rows.ledger[k]) ? rows.ledger[k].length : 0), 0);
        const leafIndex = ledgerCount + actionPos;
        const actionRow = rows.actions[actionPos];
        const expectedLeaf = M.toHex(M.actionsLeaf({
            action_index: actionRow.action_index, tx_index: actionRow.tx_index,
            action: (actionRow.action == null) ? '' : actionRow.action }));

        // Bind: the local block_merkle_root must equal both the per-block row and the
        // signed checkpoint, else this server's tree disagrees with the signed root and
        // a client could not verify the proof. Also assert the located leaf is the action.
        const localRoot = M.toHex(M.blockMerkleRoot(leaves));
        if (String(cp.block_merkle_root).toLowerCase() !== localRoot ||
            String(tr.block_merkle_root).toLowerCase() !== localRoot ||
            M.toHex(leaves[leafIndex]) !== expectedLeaf)
            return { error: 'PROOF_BLOCK_MERKLE_MISMATCH' };

        const mp = M.fixedMerkleProof(leaves, leafIndex);
        return {
            proof: {
                chain, network, height: Number(cp.block_index), action_index: aix,
                tx_index: (actionRow.tx_index == null) ? null : Number(actionRow.tx_index),
                action: actionRow.action == null ? null : String(actionRow.action),
                leaf: expectedLeaf,
                merkle_proof: { index: mp.index, siblings: mp.siblings },
                block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version
            },
            checkpoint: this._shapeCheckpoint(cp, await this.db.getMaxBlockIndex(config))
        };
    }

    // GET /BTC/api/proof/validator-set?height=S  (spec §7 / §8.1)
    // Proves the oracle_publish (and cross_chain) signer set + weights + the source-
    // deduped total S at BTC snapshot height S, against the committed stakes_root. The
    // set binds to the BTC checkpoint whose block_index == S (stakes_root there is built
    // from the SAME stake query the quorum uses at snapshot S). BTC-only (§4.1). The
    // (source, weight) preimages come from the indexer API; the SMT proof binds them, so
    // a forged preimage cannot verify. `indexerConn` is an XChainIndexerConnector.
    async validatorSetProof(config, chain, network, snapshotHeight, indexerConn, capabilities) {
        if (String(chain).toUpperCase() !== 'BTC') return { error: 'STAKES_BTC_ONLY' };
        const cp = await this.db.getCheckpointAt(config, snapshotHeight);
        if (!cp) return { error: 'SNAPSHOT_NOT_YET_CHECKPOINTED' };          // no BTC checkpoint at block_index == S yet
        if (cp.state_root == null) return { error: 'CHECKPOINT_PRE_COMMITMENT' };
        const tr = await this.db.getStateTreeRow(config, snapshotHeight);
        if (!tr || tr.stakes_root == null) return { error: 'NO_STATE_TREE' };
        let stateRoot;
        try { stateRoot = this._bindRoots(cp, tr); }
        catch (e) { return { error: (e && e.message) || 'PROOF_STATE_ROOT_MISMATCH' }; }
        const sub  = M.stateRootProof(this._subRoots(tr), 'stakes_root');
        const caps = (capabilities && capabilities.length) ? capabilities : ['oracle_publish', 'cross_chain'];
        const out  = {};
        for (const cap of caps) {
            let res;
            try { res = await indexerConn.stakeWeights(cap, Number(cp.block_index)); }
            catch (e) { return { error: (e && e.code === 'INDEXER_AUTH_REQUIRED') ? 'INDEXER_AUTH_REQUIRED' : 'INDEXER_UNAVAILABLE' }; }
            if (!res || res.error) continue;                                 // capability not configured here -> skip
            // Fail CLOSED on a truncated stake snapshot, read off the RESULT ENVELOPE.
            // The indexer marks truncation in two places: a `truncated` property on the
            // validators array (db.js getStakeWeightsByCapability) and a `truncated` field
            // on the envelope (api.js getstakeweightsbycapability). Only the envelope
            // survives the JSON-RPC hop, because JSON.stringify drops non-index properties
            // of an array, so swq's array-property guard is unreachable for a snapshot that
            // arrives over the API and this explicit check is what refuses the request. A
            // truncated set has silently-dropped sources, so its total is under-counted:
            // the authoring half of the quorum collapse the shared predicate fails closed on.
            if (res.truncated === true) return { error: 'STAKE_SNAPSHOT_TRUNCATED:' + cap };
            const validators = res.validators || [];
            // Source-deduped total from the SINGLE shared predicate module.
            // A hand-rolled dedupe here once collapsed a blank-source snapshot
            // (schema NOT NULL DEFAULT '') into ONE bucket, committing a
            // __total__ leaf equal to one validator's weight - the authoring
            // half of a 1-of-N quorum collapse. totalStake throws on
            // blank/missing source, negative weight, and truncated snapshots;
            // never author a total leaf from a snapshot that cannot quorum.
            let total;
            try { total = M.canonicalAmount(String(swq.totalStake(validators))); }
            catch (e) { return { error: 'STAKE_SNAPSHOT_MALFORMED:' + cap + ':' + ((e && e.message) || '') }; }
            const proven = [];
            for (const v of validators) {
                const smt = await this._prove(config, tr.stakes_root, M.stakeKey(String(v.pubkey), cap));
                proven.push({ pubkey: v.pubkey, source: v.source, weight: String(v.weight),
                              smt_proof: { key: smt.key, leaf_value: smt.leaf_value, compressed: smt.compressed } });
            }
            let totalProof = null;
            if (total !== M.canonicalAmount('0')) {
                const tsmt = await this._prove(config, tr.stakes_root, M.stakeKey(M.STAKE_TOTAL_PUBKEY, cap));
                totalProof = { key: tsmt.key, leaf_value: tsmt.leaf_value, compressed: tsmt.compressed };
            }
            out[cap] = { total, total_proof: totalProof, validators: proven };
        }
        return {
            proof: {
                chain, network, height: Number(cp.block_index),
                stakes_root: tr.stakes_root, balances_root: tr.balances_root,
                sub_root_path: { index: sub.index, siblings: sub.siblings },
                state_root: cp.state_root || stateRoot, state_root_version: cp.state_root_version,
                capabilities: out
            },
            checkpoint: this._shapeCheckpoint(cp, await this.db.getMaxBlockIndex(config))
        };
    }

    // GET /:coin/api/proof/contract-state/:contractIndex/:key?height=H  (spec §8.1)
    //
    // Returns a membership OR non-membership proof for one contract state key
    // against the checkpoint-height contract_state_root, plus the sub_root_path
    // that binds that sub-root into the signed state_root.
    //
    // BELOW AN ARMED HEIGHT THIS REFUSES RATHER THAN PROVING ABSENCE, and that is
    // the whole reason for the CONTRACT_STATE_NOT_COMMITTED branch. An inert slot
    // commits EMPTY_SMT_ROOT, so a non-membership proof against it verifies
    // perfectly and means NOTHING: every key is absent from an empty tree whether
    // or not the contract wrote it. Serving that as "no such key" would let a
    // client conclude a key does not exist from a commitment that never covered
    // contract state at all. Spec §4: extension-domain non-inclusion at a height
    // whose arming status the client cannot establish is "not committed", never
    // "absent".
    //
    // The caller is responsible for input validation (percent-decoding, the NUL
    // byte, the length cap) BEFORE calling: `key` reaches merkle.contractStateKey
    // here, and joinFields THROWS on a 0x00-bearing field.
    async contractStateProof(config, chain, network, contractIndex, key, height) {
        const cp = await this.db.getCheckpointAtOrAbove(config, height);
        if (!cp) return { error: 'NO_CHECKPOINT' };
        if (cp.state_root == null) return { error: 'CHECKPOINT_PRE_COMMITMENT' };
        const tr = await this.db.getStateTreeRow(config, cp.block_index);
        if (!tr) return { error: 'NO_STATE_TREE' };
        if (!tr.contract_state_root) return { error: 'CONTRACT_STATE_NOT_COMMITTED' };
        let stateRoot;
        try { stateRoot = this._bindRoots(cp, tr); }
        catch (e) { return { error: (e && e.message) || 'PROOF_STATE_ROOT_MISMATCH' }; }

        const keyBuf = M.contractStateKey(chain, network, contractIndex, key);
        const smt    = await this._prove(config, tr.contract_state_root, keyBuf);
        const sub    = M.stateRootProof(this._subRoots(tr), 'contract_state_root');
        // Leaf preimage AS-OF the checkpoint height, never the current tip: the
        // client checks leafHash(state_value) against the proven leaf, and a
        // tip-latest value would false-reject every key written after the
        // checkpoint. contract_state is append-only with block_index, so the
        // as-of-height read is exact (the escrow leaf gets the same property
        // from escrow_leaf_journal, which exists precisely because the family
        // tables it summarizes mutate in place).
        // A tombstoned key has no leaf, so non-inclusion and "deleted" are the
        // same answer here, exactly as they are in the commitment.
        const stateValue = (smt.leaf_value == null)
            ? null
            : await this.db.getContractStateValueAtHeight(config, contractIndex, key, cp.block_index);
        return {
            proof: {
                chain, network, height: Number(cp.block_index),
                contract_index: String(contractIndex),
                // The EXACT key bytes proven, echoed back. A client must compare
                // this to what it asked for: the DB read is byte-exact, but the
                // echo is what makes a folding read visible if one is ever
                // reintroduced upstream.
                state_key: key,
                state_value: stateValue,
                smt_proof: { key: smt.key, leaf_value: smt.leaf_value, compressed: smt.compressed },
                sub_root_path: { index: sub.index, siblings: sub.siblings },
                contract_state_root: tr.contract_state_root,
                balances_root: tr.balances_root, stakes_root: tr.stakes_root,
                state_root: cp.state_root || stateRoot, state_root_version: cp.state_root_version
            },
            checkpoint: this._shapeCheckpoint(cp, await this.db.getMaxBlockIndex(config))
        };
    }

    // GET /:coin/api/checkpoints/range?from=&to=  (spec §8.1, forward-following)
    async checkpointRange(config, fromH, toH, limit) {
        const rows = await this.db.getCheckpointRange(config, fromH, toH, limit);
        return { checkpoints: (rows || []).map(r => this._shapeCheckpoint(r)), count: (rows || []).length };
    }
}

module.exports = ProofServer;
