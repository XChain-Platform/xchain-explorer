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

const Utility = require('../../../../../src/lib/utility.js');

const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { mockRes, makeConfig }  = require('../../../../fixtures/mock-query-args.js');

// Same module instances XChainExplorer requires (Node module cache); stubbing
// the activation predicates here pins the verify path deterministically.
const eq   = require('../../../../../src/consensus/equivocation_header.js');
const swq  = require('../../../../../src/consensus/stake_weighted_quorum.js');
// The CHECKPOINT_COMMITMENT predicate is a registry read since W5 (activeAt over
// the literal key through the module object), so pinning it means stubbing the
// registry's activeAt for that one key and letting every other key through to
// the real table. The handle returned is a sinon stub: returns(true|false) drives
// the checkpoint-commitment verdict; sinon.restore() takes the stub down.
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const CHECKPOINT_COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
function stubCheckpointCommitment() {
    const real = gateRegistry.activeAt;
    const handle = sinon.stub();
    sinon.stub(gateRegistry, 'activeAt').callsFake(function (key, network, coin, height, time) {
        if (key === CHECKPOINT_COMMITMENT_KEY) return handle(key, network, coin, height, time);
        return real(key, network, coin, height, time);
    });
    return handle;
}

// Load XChainExplorer with heavy deps replaced.
const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB { constructor() {} async init() {} }

const XChainExplorer = proxyquire('../../../../../src/XChainExplorer.js', {
    'express': express,
    './db/index.js': MockDB,
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

module.exports = {
    proxyquire, sinon, expect, Utility, createConfigInfoStub, mockRes, makeConfig,
    eq, swq, stubCheckpointCommitment, mockApp, XChainExplorer, makeExplorer, req, CP, PK, snapRow
};
