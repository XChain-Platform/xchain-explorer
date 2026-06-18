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
 * XChain Explorer: Stake-Weighted Quorum (STAKE_WEIGHTED_QUORUM / WI-1)
 *
 * The single, CONSENSUS-CRITICAL implementation of the stake-weighted quorum
 * predicate for the explorer. The checkpoint /verify endpoint decides whether a
 * quorum-signed checkpoint meets quorum and publishes the qualifying set + the
 * activation flag so clients can re-derive the same verdict. It MUST flip on the
 * same flag-day and apply the same predicate as the hub + indexer, or its
 * `verified` field (and any client that trusts it) diverges from consensus.
 *
 * The hub/indexer/SDK keep byte-equivalent copies; the cross-service regression
 * suite asserts the activation map + predicate agree (a divergence forks the chain).
 *
 ********************************************************************/

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT the local
// processing height, so every chain + the hub flip on the same anchor.
const STAKE_WEIGHTED_QUORUM_ACTIVATION = {
    mainnet: 999999999,   // PLACEHOLDER: set the real BTC flag-day height before mainnet enable
    testnet: 0,
    regtest: 0,
};

// Whether stake-weighted quorum is in effect for a checkpoint whose BTC-anchored
// snapshot is at `snapshotBlock` on `network`. Below this → legacy count quorum.
function isStakeWeightedQuorumActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = STAKE_WEIGHTED_QUORUM_ACTIVATION[network];
    if(threshold === undefined) return false;   // unknown network → off (safe)
    return sb >= threshold;
}

// Source-deduped stake-weighted quorum test.
//   util            : explorer utility (mathjs bignumber bcadd/bcmul/bcgt)
//   validators      : full snapshot: [{ pubkey, source, weight }]  (every key of a
//                     source carries the SAME source + weight)
//   signerPubkeys   : iterable of pubkeys that produced a VALID signature
// Returns true iff 3·Σ(distinct signing-source weight) > 2·S, where
// S = Σ(weight over DISTINCT sources). A source counts ONCE no matter how many of
// its keys signed (DELEGATE v0 is additive). Degenerate cases fall out with no
// special-casing: single source → 3S>2S true; empty/zero-stake set → 0>0 false.
function meetsStakeThreshold(util, validators, signerPubkeys){
    let weightBySource = new Map();   // source -> weight (first wins; all equal per source)
    let pubkeyToSource = new Map();   // pubkey(lower) -> source
    for(let v of (validators || [])){
        let src = String(v.source);
        let pk  = String(v.pubkey).toLowerCase();
        pubkeyToSource.set(pk, src);
        if(!weightBySource.has(src))
            weightBySource.set(src, (v.weight === null || v.weight === undefined) ? '0' : String(v.weight));
    }
    // S = Σ weight over distinct sources in the snapshot.
    let S = '0';
    for(let w of weightBySource.values()) S = util.bcadd(S, w);
    // Tally = Σ weight over the DISTINCT sources represented by valid signers.
    let countedSources = new Set();
    let seenPubkeys    = new Set();
    let tally          = '0';
    for(let pk of (signerPubkeys || [])){
        let lpk = String(pk).toLowerCase();
        if(seenPubkeys.has(lpk)) continue;
        seenPubkeys.add(lpk);
        let src = pubkeyToSource.get(lpk);
        if(src === undefined) continue;          // signer not in snapshot
        if(countedSources.has(src)) continue;    // source already counted
        countedSources.add(src);
        tally = util.bcadd(tally, weightBySource.get(src));
    }
    // Strictly greater than two-thirds of stake, integer-free: 3·tally > 2·S.
    return util.bcgt(util.bcmul(tally, '3'), util.bcmul(S, '2'));
}

module.exports = {
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    isStakeWeightedQuorumActive,
    meetsStakeThreshold,
};
