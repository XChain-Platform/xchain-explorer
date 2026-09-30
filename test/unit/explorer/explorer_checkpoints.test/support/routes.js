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

const {
    sinon, expect, mockRes, eq, swq, stubCheckpointCommitment, makeExplorer, req, CP, PK, snapRow
} = require('./helpers.js');

// The checkpoint-commitment gate handle of the current test (a registry stub
// since W5); pinCheckpointCommitmentInactive() installs it before each case.
let ckptGate = null;

// GET /{COIN}/api/checkpoints
describe('XChainExplorer.processCheckpointsRequest', function () {
    it('404s an unknown coin', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'ZZZ' }), res);
        expect(res._status).to.equal(404);
        expect(res._body).to.include({ code: 'UNKNOWN_COIN' });
    });

    it('returns { checkpoints, count } from the mirrored rows', async function () {
        const explorer = makeExplorer();
        const rows = [{ checkpoint_seq: 7 }, { checkpoint_seq: 6 }];
        explorer.db.getCheckpointRows.resolves(rows);
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'btc' }), res);   // case-insensitive
        expect(res._status).to.equal(200);
        expect(res._body.checkpoints).to.deep.equal(rows);
        expect(res._body.count).to.equal(2);
    });

    it('defaults the limit to 10 and clamps it at 100', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }), res);
        expect(explorer.db.getCheckpointRows.firstCall.args[2]).to.equal(10);   // default

        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }, { limit: '9999' }), mockRes());
        expect(explorer.db.getCheckpointRows.secondCall.args[2]).to.equal(100); // clamped
    });

    // A malformed ?limit now 400s rather than being coerced by parseInt's
    // leading-prefix rule, matching processCheckpointVerifyRequest's INVALID_BLOCK_INDEX
    // guard on the sibling route. This replaces the old "-5 clamps to 1" expectation:
    // a negative is malformed input, not a value to silently repair.
    ['-5', '20junk', '1.5', '1e2', 'abc', '+5'].forEach((bad) => {
        it(`400s a malformed ?limit=${bad} instead of coercing it`, async function () {
            const explorer = makeExplorer();
            const res = mockRes();
            await explorer.processCheckpointsRequest(req({ coin: 'BTC' }, { limit: bad }), res);
            expect(res._status).to.equal(400);
            expect(res._body).to.include({ code: 'INVALID_LIMIT' });
            expect(explorer.db.getCheckpointRows.called, 'no DB call on a rejected limit').to.be.false;
        });
    });

    it('treats an empty ?limit= as absent and still applies the default of 10', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }, { limit: '' }), res);
        expect(res._status).to.equal(200);
        expect(explorer.db.getCheckpointRows.firstCall.args[2]).to.equal(10);
    });
});

describe('XChainExplorer.processCheckpointsRequest', function () {
    it('accepts a well-formed ?limit and still clamps 0 up to 1', async function () {
        const explorer = makeExplorer();
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }, { limit: '25' }), mockRes());
        expect(explorer.db.getCheckpointRows.firstCall.args[2]).to.equal(25);
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }, { limit: '0' }), mockRes());
        expect(explorer.db.getCheckpointRows.secondCall.args[2]).to.equal(1);
    });

    it('returns null-safe { checkpoints: [], count: 0 } when the query yields nothing', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves(null);
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }), res);
        expect(res._body).to.deep.equal({ checkpoints: [], count: 0 });
    });

    it('500s (not throws) when the DB query fails', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.rejects(new Error('db down'));
        const res = mockRes();
        await explorer.processCheckpointsRequest(req({ coin: 'BTC' }), res);
        expect(res._status).to.equal(500);
        expect(res._body).to.include({ code: 'SERVER_ERROR' });
    });
});

// GET /{COIN}/api/checkpoint/{blockIndex}/verify
// Pin the commitment flag-day off by default so the rootless CP fixture reads as a
// legacy row; on regtest the real activation height is 0, so every row is otherwise
// post-flag-day and the fail-closed guard would sink the quorum cases. Scoped here
// rather than file-wide: the byte-parity suite below needs the REAL predicate.
function pinCheckpointCommitmentInactive() {
    ckptGate = stubCheckpointCommitment();
    ckptGate.returns(false);
}

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('404s an unknown coin', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'ZZZ', blockIndex: '500' }), res);
        expect(res._status).to.equal(404);
        expect(res._body).to.include({ code: 'UNKNOWN_COIN' });
    });

    it('400s a non-numeric block_index', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: 'abc' }), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.include({ code: 'INVALID_BLOCK_INDEX' });
    });

    it('400s a block_index above the safe integer boundary before the DB call', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(
            req({ coin: 'BTC', blockIndex: '9007199254740992' }), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.include({ code: 'INVALID_BLOCK_INDEX' });
        expect(explorer.db.getCheckpointRows.called).to.equal(false);
    });

    it('404s when no checkpoint exists at the height', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._status).to.equal(404);
        expect(res._body).to.include({ code: 'CHECKPOINT_NOT_FOUND' });
    });

    it('legacy count quorum: a single signer of a 1-validator set verifies, and emits the raw canonical', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);

        const expectedCanon = ['XCHECKPOINT', 'BTC', 'regtest', '500', CP.block_hash,
            CP.ledger_hash, CP.actions_hash, CP.contract_hash, '7', '100'].join('|');
        expect(res._status).to.equal(200);
        expect(res._body.canonical).to.equal(expectedCanon);   // EQUIV inactive → raw
        expect(res._body.is_weighted).to.equal(false);
        expect(res._body.quorum).to.equal(1);
        expect(res._body.valid_sigs).to.equal(1);
        expect(res._body.valid_signers).to.deep.equal([PK('a')]);
        expect(res._body.verified).to.equal(true);
        expect(res._body.snapshot_available).to.equal(true);
        expect(res._body.validators).to.deep.equal([{ pubkey: PK('a'), weight: '5', source: 'src_a' }]);
    });
});

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('SPV Phase 2: post CHECKPOINT_COMMITMENT flag-day the emitted canonical commits the roots', async function () {
        // Pin the checkpoint-commitment flag-day active; EQUIV stays off (default) so the
        // canonical is the raw v0 string + the SPV root suffix, with no header wrapping.
        ckptGate.returns(true);
        const STATE_ROOT = 'd4'.repeat(32), BLOCK_MERKLE = 'e5'.repeat(32);
        const cpRow = { ...CP, state_root: STATE_ROOT, state_root_version: 1,
                        block_merkle_root: BLOCK_MERKLE, block_merkle_version: 1 };
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([cpRow]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        const expected = ['XCHECKPOINT', 'BTC', 'regtest', '500', 'c0'.repeat(32), 'a1'.repeat(32),
                          'b2'.repeat(32), 'c3'.repeat(32), '7', '100',
                          STATE_ROOT, '1', BLOCK_MERKLE, '1'].join('|');
        expect(res._body.canonical).to.equal(expected);
        expect(res._body.verified).to.equal(true);
    });

    it('SPV Phase 2: a null-root row keeps the rootless canonical even post-flag-day', async function () {
        ckptGate.returns(true);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);   // CP has no roots
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        const rootless = ['XCHECKPOINT', 'BTC', 'regtest', '500', 'c0'.repeat(32), 'a1'.repeat(32),
                          'b2'.repeat(32), 'c3'.repeat(32), '7', '100'].join('|');
        expect(res._body.canonical).to.equal(rootless);
    });

    it('SPV Phase 2: a null-root row post-flag-day fails closed, matching the SDK verifier', async function () {
        // Quorate on signatures alone; only the missing commitment may sink it.
        ckptGate.returns(true);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);   // CP has no roots
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.valid_sigs).to.equal(1);
        expect(res._body.quorum).to.equal(1);
        expect(res._body.commitment_missing).to.equal(true);
        expect(res._body.verified).to.equal(false);
    });
});

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('SPV Phase 2: one missing commitment field is enough to fail closed', async function () {
        ckptGate.returns(true);
        const explorer = makeExplorer();
        // Three of four roots present; block_merkle_version alone is null.
        explorer.db.getCheckpointRows.resolves([{ ...CP, state_root: 'd4'.repeat(32),
            state_root_version: 1, block_merkle_root: 'e5'.repeat(32), block_merkle_version: null }]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.commitment_missing).to.equal(true);
        expect(res._body.verified).to.equal(false);
    });

    it('SPV Phase 2: a rootless row BELOW the flag-day still verifies (legacy rows unaffected)', async function () {
        ckptGate.returns(false);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.commitment_missing).to.equal(false);
        expect(res._body.verified).to.equal(true);
    });

    it('rejects below the majority floor: 1 valid sig of a 4-validator set (quorum 3)', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves(
            ['a', 'b', 'c', 'd'].map(c => snapRow(PK(c), 'src_' + c)));   // only PK('a') signed
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.quorum).to.equal(3);
        expect(res._body.valid_sigs).to.equal(1);
        expect(res._body.verified).to.equal(false);
    });
});

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('a garbage-then-valid duplicate for one qualified signer still verifies (seen marked after verify)', async function () {
        // validator_signatures is untrusted transport data: an invalid entry for
        // PK('b') ordered BEFORE its genuine one must not suppress the real
        // signature. Marking "seen" on first encounter (pre-2026-07-09 behavior)
        // under-counted valid_sigs to 1 (< quorum 2) and false-rejected a quorate
        // checkpoint the SDK's hardened verifyCheckpoint accepts.
        const BAD = '0'.repeat(128), GOOD = '1'.repeat(128);
        const explorer = makeExplorer();
        explorer.util.ed25519Verify.callsFake((canonical, sig) => sig !== BAD);
        const cpRow = { ...CP, validator_signatures: JSON.stringify([
            { pubkey: PK('b'), sig: BAD },     // garbage entry first
            { pubkey: PK('a'), sig: GOOD },
            { pubkey: PK('b'), sig: GOOD }     // the genuine signature
        ]) };
        explorer.db.getCheckpointRows.resolves([cpRow]);
        explorer.db.getCapabilitySnapshotRows.resolves(
            ['a', 'b'].map(c => snapRow(PK(c), 'src_' + c)));   // quorum = 2 of 2
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.quorum).to.equal(2);
        expect(res._body.valid_sigs).to.equal(2);              // b counted once, not dropped
        expect(res._body.valid_signers).to.deep.equal([PK('a'), PK('b')]);
        expect(res._body.verified).to.equal(true);
    });

    it('reports snapshot_available=false (and unverified) when the oracle_publish set is not mirrored here', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([]);   // nothing mirrored
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.snapshot_available).to.equal(false);
        expect(res._body.verified).to.equal(false);
    });
});

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('a mirrored row with NO amount serves weight null and fails the weighted verdict closed', async function () {
        // capability_snapshots.amount is NOT NULL, so this row can only come from a
        // corrupt mirror. Resolving it to '0' (the old behavior) was the dangerous
        // repair: the source stays in the quorum's dedupe map with no stake, so the
        // denominator S shrinks while a signer keeps the whole numerator and a
        // smaller real stake clears 3*tally > 2*S. The absence is carried through
        // instead, which the REAL predicate (not stubbed here) refuses - and any
        // client re-deriving the verdict from the served set refuses identically.
        swq.isStakeWeightedQuorumActive.returns(true);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([
            { signing_pubkey: PK('a'), amount: null, source: 'src_a' },
            { signing_pubkey: PK('b'), amount: '5',  source: 'src_b' }
        ]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.is_weighted).to.equal(true);
        expect(res._body.verified).to.equal(false);
        expect(res._body.validators[0].weight).to.equal(null);
        expect(res._body.validators[1].weight).to.equal('5');
    });

    it('stake-weighted branch: defers the verdict to the source-deduped predicate', async function () {
        swq.isStakeWeightedQuorumActive.returns(true);
        const thresholdStub = sinon.stub(swq, 'meetsStakeThreshold').returns(true);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._body.is_weighted).to.equal(true);
        expect(res._body.verified).to.equal(true);
        expect(thresholdStub.calledOnce).to.equal(true);
    });

    it('EQUIV active: the canonical is the v0 raw wrapped in the uniform header', async function () {
        eq.isEquivHeaderActive.returns(true);
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.resolves([snapRow(PK('a'), 'src_a')]);
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);

        const raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', CP.block_hash,
            CP.ledger_hash, CP.actions_hash, CP.contract_hash, '7', '100'].join('|');
        const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|7', 0, raw);
        expect(res._body.canonical).to.equal(expected);
    });
});

describe('XChainExplorer.processCheckpointVerifyRequest', function () {
    beforeEach(pinCheckpointCommitmentInactive);

    it('500s (not throws) when the snapshot lookup fails', async function () {
        const explorer = makeExplorer();
        explorer.db.getCheckpointRows.resolves([{ ...CP }]);
        explorer.db.getCapabilitySnapshotRows.rejects(new Error('db down'));
        const res = mockRes();
        await explorer.processCheckpointVerifyRequest(req({ coin: 'BTC', blockIndex: '500' }), res);
        expect(res._status).to.equal(500);
        expect(res._body).to.include({ code: 'SERVER_ERROR' });
    });
});
