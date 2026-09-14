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
 * Unit tests for the ANCHOR light-client surface in src/XChainExplorer.js:
 *   GET /{COIN}/api/checkpoints              → processCheckpointsRequest
 *   GET /{COIN}/api/checkpoint/{h}/verify    → processCheckpointVerifyRequest
 *
 * Covers: coin/height validation (404/400), limit clamping, the {checkpoints,
 * count} list shape, and the verify verdict: legacy count quorum, sub-quorum
 * rejection, an unmirrored snapshot, the stake-weighted branch, and the EQUIV
 * uniform-header canonical wrapping. eq/swq activation is pinned per-test so the
 * verdict does not depend on the live flag-day maps.
 */

'use strict';

const { expect, eq, swq, XChainExplorer, CP } = require('./helpers.js');

// Canonical-string byte-parity vs the SDK builder (4th-copy drift guard).
// The XCHECKPOINT canonical is independently reconstructed in FOUR places (hub
// engine, SDK checkpoint.js, indexer anchor/index.js, and the explorer's
// canonicalCheckpointString). The cross-service parity suite compares only
// hub==SDK==indexer; this block covers the explorer's copy against the SDK so
// a drift (root-suffix ordering, EQUIV wrap gating) cannot ship with every
// suite green. Skips when the sibling xchain-sdk checkout is absent, matching
// the repo's other skip-if-absent conformance tests.
const fs   = require('fs');
const path = require('path');
const SDK_CHECKPOINT = process.env.XCHAIN_SDK_DIR
    ? path.join(process.env.XCHAIN_SDK_DIR, 'src', 'checkpoint.js')
    : path.join(__dirname, '..', '..', '..', '..', 'xchain-sdk', 'src', 'checkpoint.js');

const ROWS = {
    'legacy mainnet row (pre flag-days, no roots)': {
        ...CP, network: 'mainnet', snapshot_block: 100,
        state_root: null, block_merkle_root: null,
        state_root_version: null, block_merkle_version: null
    },
    'regtest row without roots (rootless canonical)': {
        ...CP, network: 'regtest', snapshot_block: 100,
        state_root: null, block_merkle_root: null,
        state_root_version: null, block_merkle_version: null
    },
    'regtest row with SPV roots (post CHECKPOINT_COMMITMENT shape)': {
        ...CP, network: 'regtest', snapshot_block: 100,
        state_root: 'AB'.repeat(32), state_root_version: 1,
        block_merkle_root: 'CD'.repeat(32), block_merkle_version: 1
    },
    'high-snapshot mainnet row with roots (post-flag-day shape)': {
        ...CP, network: 'mainnet', snapshot_block: 2000000,
        state_root: 'ab'.repeat(32), state_root_version: 1,
        block_merkle_root: 'cd'.repeat(32), block_merkle_version: 1
    }
};

describe('explorer canonicalCheckpointString == SDK canonicalCheckpoint @regression', function () {
    before(function () { if (!fs.existsSync(SDK_CHECKPOINT)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-sdk checkpoint not found at ' + SDK_CHECKPOINT); this.skip(); } });

    // Real flag-day gates on BOTH sides: the file-global beforeEach stubs the
    // explorer's eq/swq modules, but the SDK uses its own copies, so an
    // asymmetric stub would fake a mismatch. Drop the stubs for these tests.
    beforeEach(function () {
        if (eq.isEquivHeaderActive.restore)  eq.isEquivHeaderActive.restore();
        if (swq.isStakeWeightedQuorumActive.restore) swq.isStakeWeightedQuorumActive.restore();
    });



    for (const [name, row] of Object.entries(ROWS)) {
        it('byte-identical for a ' + name, function () {
            const sdk = require(SDK_CHECKPOINT);
            expect(typeof XChainExplorer.canonicalCheckpointString).to.equal('function');
            expect(XChainExplorer.canonicalCheckpointString({ ...row }))
                .to.equal(sdk.canonicalCheckpoint({ ...row }),
                    'explorer 4th canonical copy drifted from the SDK builder for: ' + name);
        });
    }

    // The verify route builds the canonical from the row normalizeCheckpointRows
    // returns, whose indices are decimal strings rather than Numbers.
    // The canonical String()s every index and the flag-day gates parseInt them, so
    // the signed bytes must be identical under either typing. Pin that: it is what
    // makes the wire-type change consensus-neutral.
    for (const [name, row] of Object.entries(ROWS)) {
        it('index typing is consensus-neutral (string == number) for a ' + name, function () {
            const asNumbers = { ...row, block_index: 100, checkpoint_seq: 3, snapshot_block: Number(row.snapshot_block) };
            const asStrings = { ...row, block_index: '100', checkpoint_seq: '3', snapshot_block: String(row.snapshot_block) };
            expect(XChainExplorer.canonicalCheckpointString(asStrings))
                .to.equal(XChainExplorer.canonicalCheckpointString(asNumbers),
                    'string-typed indices changed the signed canonical bytes for: ' + name);
        });
    }
});
