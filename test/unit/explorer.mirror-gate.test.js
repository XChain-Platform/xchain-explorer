'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Self-synced hub-mirror staleness surface: the two-tier gate (503 while a
// mirror has never bootstrapped, warn + annotate on lag, opt-in fail-closed),
// the /hub-mirror/status endpoint, and gating on the checkpoint route.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

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

function makeExplorer(mirrorStatus) {
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    explorer.db.pools = { BTC: {} };
    explorer.db.getCheckpointRows = sinon.stub().resolves([{ block_index: 500 }]);
    if (mirrorStatus !== undefined) {
        explorer.hubMirrorSync = {
            managesCoin: (c) => c === 'BTC' && mirrorStatus !== null,
            statusForCoin: () => mirrorStatus
        };
    }
    return explorer;
}

function req(params, query) { return { params: params || {}, query: query || {} }; }

const OK_STATUS = {
    enabled: true, target: { host: 'db1', name: 'XChain_Hub_Mirror' },
    bootstrapDrained: true, streamWatermark: 1000, mirrorLagSeconds: 5
};

describe('explorer hub-mirror staleness gate', function () {

    afterEach(function () {
        sinon.restore();
        delete process.env.MIRROR_MAX_LAG_S;
        delete process.env.MIRROR_LAG_FAIL_CLOSED;
    });

    describe('_mirrorGate()', function () {
        it('open (no annotation) when no mirror manager runs for the coin', function () {
            const gate = makeExplorer()._mirrorGate('BTC');
            expect(gate).to.deep.equal({ blocked: null, annotate: null });
        });

        it('blocks a self_sync mirror that has no hub endpoint to sync from', function () {
            // Distinct from NOT_BOOTSTRAPPED: nothing is coming, because no writer
            // exists. Serving here is what shipped stale checkpoints indefinitely.
            const gate = makeExplorer({ ...OK_STATUS, configured: false, reason: 'HUB_URL_MISSING' })
                ._mirrorGate('BTC');
            expect(gate.blocked).to.equal('MIRROR_NOT_CONFIGURED');
            expect(gate.annotate).to.equal(null);
        });

        it('names the missing configuration in the blocked body', function () {
            const body = makeExplorer()._mirrorBlockedBody('MIRROR_NOT_CONFIGURED');
            expect(body.code).to.equal('MIRROR_NOT_CONFIGURED');
            expect(body.error).to.match(/hub_url|HUB_API_URL/);
        });

        it('blocks while the mirror has never bootstrapped', function () {
            const gate = makeExplorer({ ...OK_STATUS, bootstrapDrained: false })._mirrorGate('BTC');
            expect(gate.blocked).to.equal('MIRROR_NOT_BOOTSTRAPPED');
        });

        it('annotates lag once bootstrapped', function () {
            const gate = makeExplorer(OK_STATUS)._mirrorGate('BTC');
            expect(gate.blocked).to.equal(null);
            expect(gate.annotate).to.deep.equal({ mirror_bootstrapped: true, mirror_lag_seconds: 5 });
        });

        it('lag past MIRROR_MAX_LAG_S warns but serves by default', function () {
            process.env.MIRROR_MAX_LAG_S = '60';
            const warn = sinon.stub(console, 'warn');
            const gate = makeExplorer({ ...OK_STATUS, mirrorLagSeconds: 120 })._mirrorGate('BTC');
            expect(gate.blocked).to.equal(null);
            expect(warn.calledWithMatch(sinon.match(/exceeds MIRROR_MAX_LAG_S/))).to.equal(true);
        });

        it('lag past MIRROR_MAX_LAG_S blocks under MIRROR_LAG_FAIL_CLOSED=1', function () {
            process.env.MIRROR_MAX_LAG_S = '60';
            process.env.MIRROR_LAG_FAIL_CLOSED = '1';
            sinon.stub(console, 'warn');
            const gate = makeExplorer({ ...OK_STATUS, mirrorLagSeconds: 120 })._mirrorGate('BTC');
            expect(gate.blocked).to.equal('MIRROR_STALE');
        });
    });

    describe('GET /:coin/api/hub-mirror/status', function () {
        it('404 on unknown coin', async function () {
            const res = mockRes();
            await makeExplorer().processHubMirrorStatusRequest(req({ coin: 'NOPE' }), res);
            expect(res._status).to.equal(404);
        });

        it('{enabled:false} for externally-maintained (non-self-sync) coins', async function () {
            const res = mockRes();
            await makeExplorer(null).processHubMirrorStatusRequest(req({ coin: 'BTC' }), res);
            expect(res._body).to.deep.equal({ enabled: false });
        });

        it('passes the manager status through', async function () {
            const res = mockRes();
            await makeExplorer(OK_STATUS).processHubMirrorStatusRequest(req({ coin: 'BTC' }), res);
            expect(res._body).to.deep.equal(OK_STATUS);
        });
    });

    describe('checkpoint route gating', function () {
        it('503 MIRROR_NOT_BOOTSTRAPPED before first bootstrap', async function () {
            const res = mockRes();
            await makeExplorer({ ...OK_STATUS, bootstrapDrained: false })
                .processCheckpointsRequest(req({ coin: 'BTC' }), res);
            expect(res._status).to.equal(503);
            expect(res._body.code).to.equal('MIRROR_NOT_BOOTSTRAPPED');
        });

        it('503 MIRROR_NOT_CONFIGURED when self_sync has no hub endpoint', async function () {
            const res = mockRes();
            await makeExplorer({ ...OK_STATUS, configured: false, reason: 'HUB_URL_MISSING' })
                .processCheckpointsRequest(req({ coin: 'BTC' }), res);
            expect(res._status).to.equal(503);
            expect(res._body.code).to.equal('MIRROR_NOT_CONFIGURED');
        });

        it('serves with mirror annotations once bootstrapped', async function () {
            const res = mockRes();
            await makeExplorer(OK_STATUS).processCheckpointsRequest(req({ coin: 'BTC' }), res);
            expect(res._status).to.equal(200);
            expect(res._body.mirror_bootstrapped).to.equal(true);
            expect(res._body.mirror_lag_seconds).to.equal(5);
            expect(res._body.checkpoints).to.deep.equal([{ block_index: 500 }]);
        });

        it('unaffected (no annotations) in externally-maintained mode', async function () {
            const res = mockRes();
            await makeExplorer(null).processCheckpointsRequest(req({ coin: 'BTC' }), res);
            expect(res._status).to.equal(200);
            expect(res._body).to.not.have.property('mirror_bootstrapped');
        });
    });

    // The SPV proof routes bind to the same mirror-maintained state_checkpoints as
    // the balance-proof/checkpoint routes, so they must inherit the staleness gate
    // too, rather than answering off a frozen/empty mirror while their siblings 503.
    describe('proof route gating', function () {
        it('action-proof: 503 MIRROR_NOT_BOOTSTRAPPED before first bootstrap', async function () {
            const res = mockRes();
            await makeExplorer({ ...OK_STATUS, bootstrapDrained: false })
                .processActionProofRequest(req({ coin: 'BTC', actionIndex: '1' }), res);
            expect(res._status).to.equal(503);
            expect(res._body.code).to.equal('MIRROR_NOT_BOOTSTRAPPED');
        });

        it('validator-set-proof: 503 MIRROR_NOT_BOOTSTRAPPED before first bootstrap', async function () {
            const res = mockRes();
            await makeExplorer({ ...OK_STATUS, bootstrapDrained: false })
                .processValidatorSetProofRequest(req({ coin: 'BTC' }, { height: '100' }), res);
            expect(res._status).to.equal(503);
            expect(res._body.code).to.equal('MIRROR_NOT_BOOTSTRAPPED');
        });

        it('action-proof: gate stays open (no 503) in externally-maintained mode', async function () {
            const res = mockRes();
            const explorer = makeExplorer(null);
            // proofServer must not be reached via the gate; stub it so if the gate is
            // (correctly) open, the handler proceeds and we do not 503 on the gate.
            explorer.parseCoinCode = () => null; // short-circuits with 404 AFTER the open gate
            await explorer.processActionProofRequest(req({ coin: 'BTC', actionIndex: '1' }), res);
            expect(res._status).to.not.equal(503);
        });

        // The stake-snapshot proof errors carry a ':<capability>[:<detail>]' suffix, so an
        // exact-match error map misses them: the client gets a generic 500 and the raw
        // suffix, exception text included, echoed back in `code`.
        describe('validator-set-proof error mapping', function () {
            function routed(error) {
                const res = mockRes();
                const explorer = makeExplorer(null);
                explorer.parseCoinCode = () => ({ coin: 'BTC', network: 'MAINNET' });
                explorer.proofServer = { validatorSetProof: async () => ({ error }) };
                process.env.INDEXER_API_URL = 'http://indexer.invalid/api';
                return explorer.processValidatorSetProofRequest(req({ coin: 'BTC' }, { height: '100' }), res)
                    .then(() => { delete process.env.INDEXER_API_URL; return res; },
                          (e) => { delete process.env.INDEXER_API_URL; throw e; });
            }

            it('maps a suffixed STAKE_SNAPSHOT_TRUNCATED to 409 on its prefix', async function () {
                const res = await routed('STAKE_SNAPSHOT_TRUNCATED:oracle_publish');
                expect(res._status).to.equal(409);
                expect(res._body.code).to.equal('STAKE_SNAPSHOT_TRUNCATED');
            });

            it('maps STAKE_SNAPSHOT_MALFORMED to 500 without echoing the exception text', async function () {
                const res = await routed('STAKE_SNAPSHOT_MALFORMED:oracle_publish:blank/missing source would collapse the stake bucket');
                expect(res._status).to.equal(500);
                expect(res._body.code).to.equal('STAKE_SNAPSHOT_MALFORMED');
            });

            it('leaves a suffix-free code with its own status and code', async function () {
                const res = await routed('SNAPSHOT_NOT_YET_CHECKPOINTED');
                expect(res._status).to.equal(409);
                expect(res._body.code).to.equal('SNAPSHOT_NOT_YET_CHECKPOINTED');
            });
        });
    });
});
