/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - checkpoint routes
 *
 * The checkpoint surface: the latest signed checkpoints, one height re-verified
 * against the mirrored oracle_publish snapshot, the balance proof bound to a
 * checkpoint, and a checkpoint range. The canonical signing string these answers
 * are verified against lives here too, beside its only caller.
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

const eq   = require('../consensus/equivocation_header.js');
const swq  = require('../consensus/stake_weighted_quorum.js');
// The CHECKPOINT_COMMITMENT flag day is a registry row read by its literal key
// (W5): the predicate is activeAt over the checkpoint's BTC-anchored snapshot_block.
const gateRegistry = require('../consensus/gate_registry');
const CHECKPOINT_COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
function isCheckpointCommitmentActive(snapshotBlock, network){
    return gateRegistry.activeAt(CHECKPOINT_COMMITMENT_KEY, network, null, snapshotBlock, null);
}
// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

class CheckpointProofs {

    async processCheckpointsRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            // Strict shape before parsing, mirroring processCheckpointVerifyRequest below:
            // parseInt let '20junk', '1e2' and '1.5' through by prefix, and a negative
            // clamped to 1 rather than reading as the malformed input it is.
            let limit = 10;
            if(!this.util.isNull(req.query.limit)){
                if(!/^[0-9]+$/.test(String(req.query.limit)))
                    return res.status(400).json({ error: 'Invalid limit', code: 'INVALID_LIMIT' });
                limit = Math.max(1, Math.min(parseInt(req.query.limit, 10), 100));
            }
            let rows = await this.db.getCheckpointRows({ coin, data: {} }, null, limit);
            return res.json({ checkpoints: rows || [], count: (rows || []).length, ...(gate.annotate || {}) });
        } catch (e) {
            log.error('CHECKPOINTS_REQUEST_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/checkpoint/{blockIndex}/verify: re-verify the checkpoint at a
    // height against the mirrored oracle_publish capability snapshot. Returns the
    // canonical signing string + qualifying validator set so a client can ALSO
    // verify independently rather than trusting this server's `verified` flag.
    async processCheckpointVerifyRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let blockIndex = req.params.blockIndex;
            if(!this.util.isSafeIntegerParam(blockIndex))
                return res.status(400).json({ error: 'Invalid block_index', code: 'INVALID_BLOCK_INDEX' });
            let config = { coin, data: {} };
            let rows = await this.db.getCheckpointRows(config, Number(blockIndex), 1);
            if(!rows || rows.length === 0)
                return res.status(404).json({ error: 'No checkpoint at this height', code: 'CHECKPOINT_NOT_FOUND' });
            let cp = rows[0];

            // Canonical signing string, byte-identical to the hub engine + ANCHOR
            // verifier + SDK (canonicalCheckpointString below the class; exported so
            // the unit suite cross-checks it against the SDK builder byte-for-byte).
            let canonical = canonicalCheckpointString(cp);

            let validators = await this.db.getCapabilitySnapshotRows(config, 'oracle_publish', cp.snapshot_block) || [];

            return res.json(this.checkpointVerifyResult(cp, canonical, validators));
        } catch (e) {
            log.error('CHECKPOINT_VERIFY_REQUEST_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // The verify verdict itself, over rows already read: nothing here touches the
    // database or the response, so the served body is one pure function of the
    // checkpoint row and the capability snapshot it is judged against.
    checkpointVerifyResult(cp, canonical, validators){
        let qualified  = new Set(validators.map(v => String(v.signing_pubkey).toLowerCase()));
        let quorum     = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));

        // Stake-weighted-or-count is gated on the BTC-anchored snapshot_block +
        // network, the same flag-day the hub/indexer flip on. Below it the count
        // quorum decides; at/above it the VALID signers' distinct stake sources
        // must clear the source-deduped 3·Σ > 2·S predicate.
        let isWeighted = swq.isStakeWeightedQuorumActive(cp.snapshot_block, cp.network);

        let counted      = this.countCheckpointSignatures(cp, canonical, qualified);
        let validatorSet = this.checkpointValidatorSet(validators);

        // Reject a post-flag-day row missing any commitment field, mirroring the SDK's
        // commitmentMissing (xchain-sdk/src/checkpoint.js): canonicalCheckpointString
        // appends the root suffix only when all four are present, so such a row would
        // otherwise verify against the LEGACY rootless preimage.
        let commitmentMissing = isCheckpointCommitmentActive(cp.snapshot_block, cp.network)
            && (cp.state_root == null || cp.block_merkle_root == null
                || cp.state_root_version == null || cp.block_merkle_version == null);

        let verified = !commitmentMissing && (isWeighted
            ? (qualified.size > 0 && swq.meetsStakeThreshold(validatorSet, counted.validSigners))
            : (qualified.size > 0 && counted.validSigs >= quorum));

        return {
            checkpoint:    cp,
            canonical:     canonical,
            validators:    validatorSet,
            is_weighted:   isWeighted,
            quorum:        quorum,
            valid_sigs:    counted.validSigs,
            valid_signers: counted.validSigners,
            verified:      verified,
            // Tells a client the verdict is STRUCTURAL, not a signature shortfall.
            commitment_missing:      commitmentMissing,
            // qualified.size === 0 → the oracle_publish snapshot isn't mirrored
            // here; the sigs may still be valid (clients can verify elsewhere).
            snapshot_available:      qualified.size > 0,
            signatures_unparseable:  counted.sigsParseFailed
        };
    }

    // How many of the row's signatures both verify against the canonical string and
    // belong to a qualifying validator, and who signed them. `sigsParseFailed` is
    // carried out rather than thrown so an unparseable column reads as zero valid
    // signatures with the reason attached to the answer.
    countCheckpointSignatures(cp, canonical, qualified){
        let sigs = [];
        let sigsParseFailed = false;
        // getCheckpointRows now normalizes validator_signatures to a parsed
        // array (api-contracts wire-type unification); keep the string
        // branch for defense in depth against an unnormalized row.
        if (Array.isArray(cp.validator_signatures)) sigs = cp.validator_signatures;
        else { try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch(e){ log.error('CHECKPOINT_VERIFY_SIGNATURES_PARSE_FAILED', { chain: cp.chain, block_index: cp.block_index, err: e && e.message ? e.message : e, stack: e && e.stack }); sigs = []; sigsParseFailed = true; } }
        let validSigs = 0, seen = new Set(), validSigners = [];
        for(let s of sigs){
            let pk  = String(s && s.pubkey || '').toLowerCase();
            let sig = String(s && s.sig || '');
            if(!pk || seen.has(pk) || !qualified.has(pk)) continue;
            // Only mark a pubkey "seen" once its signature actually verifies
            // (matching the SDK's hardened verifyCheckpoint): marking on first
            // encounter would let a garbage-then-valid pair of entries for the
            // same qualified validator suppress the real signature (order-
            // dependent quorum under-count), failing a quorate checkpoint closed.
            if(this.util.ed25519Verify(canonical, sig, pk)){ seen.add(pk); validSigs++; validSigners.push(pk); }
        }
        return { validSigs, validSigners, sigsParseFailed };
    }

    // Per-validator { pubkey, weight, source } so a client re-derives the
    // weighted verdict locally: weight is the key's stake amount, source its
    // stake-weight grouping key (empty string in the legacy count regime).

    // Carry a missing amount through as null, NEVER as '0'. Since
    // capability_snapshots.amount is NOT NULL, a null means a corrupt mirror
    // row, and resolving it to '0' keeps that source in the quorum's dedupe map
    // carrying no stake: the denominator S shrinks while a signer keeps the full
    // numerator, so a smaller real stake clears 3*tally > 2*S. Null makes
    // meetsStakeThreshold fail closed here AND in any client re-deriving from
    // this same served set.
    checkpointValidatorSet(validators){
        return validators.map(v => ({
            pubkey: String(v.signing_pubkey).toLowerCase(),
            weight: (v.amount === null || v.amount === undefined) ? null : String(v.amount),
            source: String(v.source != null ? v.source : '')
        }));
    }

    // GET /{COIN}/api/proof/balance/{address}/{tick}?height=H  (SPV spec §4.4/§8.1)
    // Returns a BalanceProof bound to the nearest signed checkpoint at height >= H
    // (or the latest), which the client recomputes locally against the committed
    // state_root. A claimed-zero balance comes back as an SMT non-inclusion proof.
    async processBalanceProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Balance proofs bind to a quorum-signed checkpoint from the mirror,
            // so they inherit the same staleness gate as the checkpoint routes.
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let address = String(req.params.address || '');
            let tick    = String(req.params.tick || '');
            if(!address || !tick)
                return res.status(400).json({ error: 'address and tick are required', code: 'MISSING_PARAMETER' });
            let height = (req.query.height !== undefined && req.query.height !== '') ? req.query.height : null;
            if(height !== null && !this.util.isSafeIntegerParam(height))
                return res.status(400).json({ error: 'Invalid height', code: 'INVALID_HEIGHT' });
            let config = { coin, data: {} };
            let result = await this.proofServer.balanceProof(config, parsed.coin, parsed.network, address, tick,
                                                             height === null ? null : Number(height));
            if(result.error){
                let map = { NO_CHECKPOINT: [404, 'No signed checkpoint at or above this height'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            log.error('BALANCE_PROOF_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/checkpoints/range?from=&to=  (SPV spec §8.1, forward-following)
    async processCheckpointsRangeRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this.mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this.mirrorBlockedBody(gate.blocked));
            let from = req.query.from, to = req.query.to;
            if(!this.util.isSafeIntegerParam(from) || !this.util.isSafeIntegerParam(to))
                return res.status(400).json({ error: 'from and to (integers) are required', code: 'INVALID_RANGE' });
            from = Number(from); to = Number(to);
            if(to < from)
                return res.status(400).json({ error: 'to must be >= from', code: 'INVALID_RANGE' });
            // Cap the span so a single request cannot scan an unbounded range.
            let limit = Math.min(500, (to - from) + 1);
            let config = { coin, data: {} };
            return res.json(await this.proofServer.checkpointRange(config, from, to, limit));
        } catch(e){
            log.error('CHECKPOINTS_RANGE_REQUEST_FAILED', { err: e && e.message });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/action/{actionIndex}  (SPV spec §5/§8.1)
}

// The explorer's copy of the XCHECKPOINT canonical signing string. Five independent
// sibling copies of the checkpoint family must change in lockstep with it: the hub's
// StateCheckpointEngine.canonicalCheckpoint, xchain-sdk/src/checkpoint.js and
// xchain-sync/src/checkpoint.js canonicalCheckpoint (all gated like this one), and the
// indexer's ANCHOR v0 section verifier and bridge_proof_client/checkpoint_source.js
// checkpointCanonical (both append the root suffix unconditionally, so they match this
// string only at/above the CHECKPOINT_COMMITMENT flag day). The ten-field base is also
// rebuilt by the rootless archive family: the indexer's ANCHOR v1 leg, its
// bin/recovery.js wrapperCanonical, and the hub's archiveCanonical (which nests
// rawCanonicalCheckpoint rather than re-joining).
// At/above the EQUIV flag-day (gated on the BTC snapshot_block + network) the v0
// canonical is wrapped in the uniform header (TAG=XCHECKPOINT, v0 ROUND_ID, VIEW=0).
// SPV Phase 2 (spec §6.1): post CHECKPOINT_COMMITMENT flag-day the signed string
// additively commits the light-client roots + version bytes from the checkpoint row,
// appended to the RAW string BEFORE the EQUIV wrap. Append only when the roots are
// present (legacy/null-root rows keep their original rootless canonical; the hub
// never signs a rootless checkpoint post-flag-day). Exported for the byte-parity
// cross-check against the SDK builder in explorer.checkpoints.test.js.
function canonicalCheckpointString(cp){
    let canonRaw = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    if(isCheckpointCommitmentActive(cp.snapshot_block, cp.network) &&
       cp.state_root != null && cp.block_merkle_root != null &&
       cp.state_root_version != null && cp.block_merkle_version != null)
        canonRaw += '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
                           String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    return eq.isEquivHeaderActive(cp.snapshot_block, cp.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
            cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq, 0, canonRaw)
        : canonRaw;
}

module.exports = { methods: CheckpointProofs.prototype, canonicalCheckpointString };
