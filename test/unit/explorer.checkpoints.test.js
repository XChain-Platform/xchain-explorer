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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../src/utility.js');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes, makeConfig }  = require('../fixtures/mock-query-args.js');

// Same module instances XChainExplorer requires (Node module cache); stubbing
// the activation predicates here pins the verify path deterministically.
const eq   = require('../../src/equivocation_header.js');
const swq  = require('../../src/stake_weighted_quorum.js');
const ckpt = require('../../src/checkpoint_commitment_activation.js');

// Load XChainExplorer with heavy deps replaced.
const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB { constructor() {} async init() {} }

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB,
    'fs': { existsSync: () => true, readFileSync: () => 'mock' }
});

// Helpers
function makeExplorer() {
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    explorer.db.pools = { BTC: {} };                       // BTC is a known coin
    explorer.db.getCheckpointRows = sinon.stub().resolves([]);
    explorer.db.getCapabilitySnapshotRows = sinon.stub().resolves([]);
    // Signature cryptography is out of scope here; drive the verdict via snapshot
    // membership + how many sigs are supplied. Verify is exercised end-to-end in
    // the SDK CheckpointVerifier + indexer ANCHOR suites.
    sinon.stub(explorer.util, 'ed25519Verify').returns(true);
    return explorer;
}

function req(params, query) { return { params: params || {}, query: query || {} }; }

const CP = {
    chain: 'BTC', network: 'regtest', block_index: 500,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 100,
    validator_signatures: JSON.stringify([{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }])
};
const PK = (c) => c.repeat(64);
const snapRow = (pk, source) => ({ signing_pubkey: pk, amount: '5', source: source });

beforeEach(function () {
    // Default: legacy count quorum, no EQUIV header. Individual tests override.
    sinon.stub(eq,  'isEquivHeaderActive').returns(false);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
});
afterEach(function () { sinon.restore(); });

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
describe('XChainExplorer.processCheckpointVerifyRequest', function () {

    // Pin the commitment flag-day off by default so the rootless CP fixture reads as a
    // legacy row; on regtest the real activation height is 0, so every row is otherwise
    // post-flag-day and the fail-closed guard would sink the quorum cases. Scoped here
    // rather than file-wide: the byte-parity suite below needs the REAL predicate.
    beforeEach(function () { sinon.stub(ckpt, 'isCheckpointCommitmentActive').returns(false); });

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
        expect(res._body.verified).to.equal(true);
        expect(res._body.snapshot_available).to.equal(true);
        expect(res._body.validators).to.deep.equal([{ pubkey: PK('a'), weight: '5', source: 'src_a' }]);
    });

    it('SPV Phase 2: post CHECKPOINT_COMMITMENT flag-day the emitted canonical commits the roots', async function () {
        // Pin the checkpoint-commitment flag-day active; EQUIV stays off (default) so the
        // canonical is the raw v0 string + the SPV root suffix, with no header wrapping.
        ckpt.isCheckpointCommitmentActive.returns(true);
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
        ckpt.isCheckpointCommitmentActive.returns(true);
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
        ckpt.isCheckpointCommitmentActive.returns(true);
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

    it('SPV Phase 2: one missing commitment field is enough to fail closed', async function () {
        ckpt.isCheckpointCommitmentActive.returns(true);
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
        ckpt.isCheckpointCommitmentActive.returns(false);
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


// Canonical-string byte-parity vs the SDK builder (4th-copy drift guard).
// The XCHECKPOINT canonical is independently reconstructed in FOUR places (hub
// engine, SDK checkpoint.js, indexer anchor.js, and the explorer's
// canonicalCheckpointString). The cross-service parity suite compares only
// hub==SDK==indexer; this block covers the explorer's copy against the SDK so
// a drift (root-suffix ordering, EQUIV wrap gating) cannot ship with every
// suite green. Skips when the sibling xchain-sdk checkout is absent, matching
// the repo's other skip-if-absent conformance tests.
describe('explorer canonicalCheckpointString == SDK canonicalCheckpoint @regression', function () {
    const fs   = require('fs');
    const path = require('path');
    const SDK_CHECKPOINT = process.env.XCHAIN_SDK_DIR
        ? path.join(process.env.XCHAIN_SDK_DIR, 'src', 'checkpoint.js')
        : path.join(__dirname, '..', '..', '..', 'xchain-sdk', 'src', 'checkpoint.js');
    before(function () { if (!fs.existsSync(SDK_CHECKPOINT)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-sdk checkpoint not found at ' + SDK_CHECKPOINT); this.skip(); } });

    // Real flag-day gates on BOTH sides: the file-global beforeEach stubs the
    // explorer's eq/swq modules, but the SDK uses its own copies, so an
    // asymmetric stub would fake a mismatch. Drop the stubs for these tests.
    beforeEach(function () {
        if (eq.isEquivHeaderActive.restore)  eq.isEquivHeaderActive.restore();
        if (swq.isStakeWeightedQuorumActive.restore) swq.isStakeWeightedQuorumActive.restore();
    });

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

    for (const [name, row] of Object.entries(ROWS)) {
        it('byte-identical for a ' + name, function () {
            const sdk = require(SDK_CHECKPOINT);
            expect(typeof XChainExplorer.canonicalCheckpointString).to.equal('function');
            expect(XChainExplorer.canonicalCheckpointString({ ...row }))
                .to.equal(sdk.canonicalCheckpoint({ ...row }),
                    'explorer 4th canonical copy drifted from the SDK builder for: ' + name);
        });
    }

    // The verify route builds the canonical from the row _normalizeCheckpointRows
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

// ─────────────────────────────────────────────────────────────────────────
// M2.1 data leg: Database#getCheckpoints / Database#getCheckpoint (src/db.js)
//
// These exercise the real db.js SQL-generating methods directly, the way
// db.more-queries.test.js's Database#getPriceSnapshots / #getOraclePrices
// suites cover the OTHER hub-mirrored, co-located-DB-only list views: a
// separate proxyquired Database (mariadb stubbed out, no live connection),
// not the MockDB used by the route-level suites above.
// ─────────────────────────────────────────────────────────────────────────

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeRealDb() {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util };
    return new DatabaseReal(mockExplorer);
}

const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function checkpointsConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getCheckpoints',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

function checkpointConfig(search) {
    return makeConfig({ data: { method: 'getCheckpoint', search } });
}

describe('Database#getCheckpoints (M2.1 data leg)', () => {

    it('returns a 3-element array', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCheckpoints(checkpointsConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('database-qualifies state_checkpoints, aliased m, for both the count and the list query', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCheckpoints(checkpointsConfig());
        expect(query).to.include('`XChain_Hub`.state_checkpoints m');
        expect(count).to.include('`XChain_Hub`.state_checkpoints m');
    });

    it('emits exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig());
        const cols = ['m.block_index', 'm.created_at', 'm.checkpoint_seq', 'm.snapshot_block',
                      'm.state_root', 'm.block_merkle_root', 'JSON_LENGTH(m.validator_signatures) AS signer_count'];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
        // The list carries only the derived signer count, never the raw
        // validator_signatures column, so the detail family's wire-format
        // normalization (see _normalizeCheckpointRows) has nothing to act on here.
        const selectClause = query.slice(0, query.indexOf('FROM'));
        expect(selectClause).to.not.include('m.validator_signatures,');
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const OFFSET_SQL = ' AND m.block_index < ?';
        const [query] = await db.getCheckpoints(checkpointsConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        // The inner bounded derived table has its OWN "ORDER BY block_index DESC",
        // so anchor on the outer clause specifically (qualified by the m. alias)
        // rather than the first ORDER BY in the string.
        const orderIdx  = query.indexOf('ORDER BY m.block_index');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    it('picks the latest per height WITHOUT a GROUP BY over the mirror', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCheckpoints(checkpointsConfig());
        // The earlier shape pre-selected a fixed window of raw rows and GROUPed it,
        // which capped how deep paging could reach. Latest-per-height is now a
        // correlated MAX on the unique key, so no GROUP BY may appear at all: a
        // reintroduced one is either an unbounded scan or a windowed truncation.
        expect(query).to.not.match(/GROUP BY/i);
        expect(count).to.not.match(/GROUP BY/i);
        expect(query).to.match(/checkpoint_seq = \(SELECT MAX\(s\.checkpoint_seq\)/);
    });

    it('the paging cursor is not scoped away by the latest-per-height lookup', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCheckpoints(checkpointsConfig({
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: ' AND m.block_index < ?', offsetArgs: [1000] }
            }
        }));
        // The defect this guards: with the old derived table, the cursor applied only
        // outside a window pinned to the tip, so pages below the window matched nothing.
        // The cursor must sit in the same WHERE as the correlated predicate, and after
        // it, because getData appends the cursor args last.
        const cursorAt = query.indexOf('m.block_index < ?');
        const latestAt = query.indexOf('checkpoint_seq = (SELECT MAX(');
        expect(cursorAt, 'cursor predicate missing').to.be.greaterThan(-1);
        expect(cursorAt, 'cursor must follow the correlated predicate').to.be.greaterThan(latestAt);
    });

    it('count and list both bind chain/network TWICE (outer filter + correlated subquery)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getCheckpoints(checkpointsConfig());
        expect(args).to.deep.equal(['BTC', 'mainnet', 'BTC', 'mainnet']);
    });

    it('no checkpoint hub DB configured -> fails loud (no silent empty local mirror)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCheckpoints(checkpointsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeRealDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getCheckpoints(checkpointsConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });

    it('getMaxMethodResults clamps getCheckpoints to the platform default of 100', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getCheckpoints')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getCheckpoints');
    });

    it('getQueryWhereSql anchors getCheckpoints on m.id IS NOT NULL (no action_index column)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCheckpoints', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });

    it('getQueryOffsetSql gives getCheckpoints the m.block_index cursor field (not m.id)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getCheckpoints', offset: { action: 'next', start: 500, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.block_index');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([500]);
    });
});

describe('Database#getCheckpoint (M2.1 single-height detail leg)', () => {

    it('binds the requested height plus the source filterParams positionally', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCheckpoint(checkpointConfig('500'));
        const [, query, args] = doQueryStub.firstCall.args;
        expect(query).to.include('`XChain_Hub`.state_checkpoints');
        expect(query).to.include('ORDER BY checkpoint_seq DESC LIMIT 1');
        expect(args).to.deep.equal([500, 'BTC', 'mainnet']);
    });

    it('selects the full detail column set (state + roots + raw signatures), no verify math', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCheckpoint(checkpointConfig('500'));
        const [, query] = doQueryStub.firstCall.args;
        for (const col of ['chain', 'network', 'block_index', 'block_hash', 'ledger_hash', 'actions_hash',
                            'contract_hash', 'checkpoint_seq', 'snapshot_block', 'state_root',
                            'state_root_version', 'block_merkle_root', 'block_merkle_version',
                            'validator_signatures', 'created_at'])
            expect(query).to.include(col);
    });

    it('returns [null] (array-wrapped) when the height has no checkpoint', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getCheckpoint(checkpointConfig('500'));
        expect(result).to.deep.equal([null]);
    });

    it('normalizes the found row via _normalizeCheckpointRows (BigInt-ish fields stringified, signatures parsed)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const row = {
            chain: 'BTC', network: 'mainnet', block_index: 500n, block_hash: 'h'.repeat(64),
            ledger_hash: 'l'.repeat(64), actions_hash: 'a'.repeat(64), contract_hash: 'c'.repeat(64),
            checkpoint_seq: 7n, snapshot_block: 100n,
            state_root: null, state_root_version: null, block_merkle_root: null, block_merkle_version: null,
            validator_signatures: JSON.stringify([{ pubkey: 'p'.repeat(64), sig: 's'.repeat(128) }]),
            created_at: new Date('2026-08-01T00:00:00Z')
        };
        sinon.stub(db, 'doQuery').resolves([row]);
        const [result] = await db.getCheckpoint(checkpointConfig('500'));
        expect(result.block_index).to.equal('500');
        expect(result.checkpoint_seq).to.equal('7');
        expect(result.snapshot_block).to.equal('100');
        expect(result.validator_signatures).to.deep.equal([{ pubkey: 'p'.repeat(64), sig: 's'.repeat(128) }]);
    });

    it('no checkpoint hub DB configured -> fails loud', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCheckpoint(checkpointConfig('500')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});
