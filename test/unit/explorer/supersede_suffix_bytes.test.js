/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Regression coverage for checkpoint supersession suffix bytes.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    hasSupersedeFields,
    supersedeSuffix
} = require('../../../src/explorer/supersede_suffix.js');
const { canonicalCheckpointString } = require('../../../src/explorer/proofs.js');

const RULES_DIGEST = 'CD'.repeat(32);

function testsFieldPresence(){
    expect(hasSupersedeFields()).to.equal(false);
    expect(hasSupersedeFields({})).to.equal(false);
    expect(hasSupersedeFields({ supersedes_from: null, rules_digest: null })).to.equal(false);
    expect(hasSupersedeFields({ supersedes_from: 0 })).to.equal(true);
    expect(hasSupersedeFields({ rules_digest: RULES_DIGEST })).to.equal(true);
}

function testsEmptySuffix(){
    expect(supersedeSuffix()).to.equal('');
    expect(supersedeSuffix({ block_index: 5 })).to.equal('');
    expect(supersedeSuffix({ supersedes_from: null, rules_digest: null })).to.equal('');
}

function testsExactSuffixBytes(){
    expect(supersedeSuffix({ supersedes_from: '12', rules_digest: RULES_DIGEST }))
        .to.equal('|SUPERSEDE|12|' + RULES_DIGEST.toLowerCase());
}

function testsIncompleteFields(){
    expect(() => supersedeSuffix({ rules_digest: RULES_DIGEST })).to.throw();
    expect(() => supersedeSuffix({ supersedes_from: 3 })).to.throw();
}

function testsInvalidSupersedesFrom(){
    expect(() => supersedeSuffix({ supersedes_from: 1.5, rules_digest: RULES_DIGEST })).to.throw();
    expect(() => supersedeSuffix({ supersedes_from: -1, rules_digest: RULES_DIGEST })).to.throw();
    expect(() => supersedeSuffix({
        supersedes_from: Number.MAX_SAFE_INTEGER + 1,
        rules_digest: RULES_DIGEST
    })).to.throw();
}

function testsInvalidRulesDigest(){
    expect(() => supersedeSuffix({ supersedes_from: 1, rules_digest: 'cd' })).to.throw();
    expect(() => supersedeSuffix({ supersedes_from: 1, rules_digest: 'g'.repeat(64) })).to.throw();
}

function testsPlainCanonicalCheckpoint(){
    const checkpoint = {
        chain: 'LTC',
        network: 'mainnet',
        block_index: 5,
        block_hash: 'ab'.repeat(32),
        ledger_hash: 'cd'.repeat(32),
        actions_hash: 'ef'.repeat(32),
        contract_hash: '12'.repeat(32),
        checkpoint_seq: 1,
        snapshot_block: 100
    };

    expect(canonicalCheckpointString(checkpoint)).not.to.include('SUPERSEDE');
}

function supersedeSuffixBytes(){
    it('detects non-null supersedes_from or rules_digest fields', testsFieldPresence);
    it('returns an empty suffix when both supersession fields are absent or null', testsEmptySuffix);
    it('serializes string supersedes_from and uppercase rules_digest to exact bytes',
        testsExactSuffixBytes);
    it('throws when only one supersession field is present', testsIncompleteFields);
    it('throws when supersedes_from is not a non-negative safe integer',
        testsInvalidSupersedesFrom);
    it('throws when rules_digest is not 64 hexadecimal characters', testsInvalidRulesDigest);
    it('leaves canonicalCheckpointString free of SUPERSEDE text for a plain checkpoint',
        testsPlainCanonicalCheckpoint);
}

describe('@regression explorer checkpoint supersede suffix bytes', supersedeSuffixBytes);
