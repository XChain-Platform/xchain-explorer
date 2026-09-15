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

const { sinon, expect, makeAxiosStub, loadConnector } = require('./helpers.js');

function registerConfigResultBasics() {
    describe('applyConfigResult() and config-delta merge', function () {
        it('accepts an array of endpoint URLs directly', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://a:1', 'http://b:2']);
            expect(c.urls).to.deep.equal(['http://a:1', 'http://b:2']);
        });

        it('replaces with the full tree for a bare-map result (legacy hub)', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://localhost:3000']);
            let tree = { BTC: { mainnet: { mod: { p: '1' } } } };
            let out = c.applyConfigResult(tree);
            expect(out).to.deep.equal(tree);
            expect(c.lastSeq).to.equal(0);
            expect(c.lastWatermark).to.equal(0);
        });

        it('resets the cursor when the hub reports no watermark', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://localhost:3000']);
            c.lastWatermark = 50;
            let out = c.applyConfigResult({ configs: { BTC: {} }, seq: 7 });
            expect(c.lastSeq).to.equal(7);
            expect(c.lastWatermark).to.equal(0);
            expect(out).to.deep.equal({ BTC: {} });
        });

        it('returns the full payload on the first watermarked fetch', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://localhost:3000']);
            let out = c.applyConfigResult({ configs: { BTC: { mainnet: {} } }, seq: 1, watermark: 1000 });
            expect(c.lastWatermark).to.equal(1000);
            expect(out).to.deep.equal({ BTC: { mainnet: {} } });
        });

        it('merges a delta into the cached tree on a subsequent watermarked fetch', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://localhost:3000']);
            c.configs = { BTC: { mainnet: { fees: { a: '1' } } } };
            c.lastWatermark = 1000; // we sent a cursor last time
            let out = c.applyConfigResult({
                configs: { BTC: { mainnet: { fees: { b: '2' }, oracle: { x: '9' } }, regtest: { m: { p: '3' } } } },
                seq: 2, watermark: 2000
            });
            expect(c.lastWatermark).to.equal(2000);
            expect(out.BTC.mainnet.fees).to.deep.equal({ a: '1', b: '2' }); // existing kept, new merged
            expect(out.BTC.mainnet.oracle).to.deep.equal({ x: '9' });        // new module folded in
            expect(out.BTC.regtest.m).to.deep.equal({ p: '3' });             // new network folded in
        });
    });
}

function registerConfigResultFailover() {
    describe('applyConfigResult() and config-delta merge', function () {
        it('resets the cursor and re-fetches full when it fails over to a different endpoint', async function () {
            // A wall-clock cursor from hub A is not valid against hub B (each stamps
            // updated_at at its own apply time), so on failover the connector must
            // discard the stale cursor and re-fetch the full tree from the new endpoint.
            const axiosStub = makeAxiosStub();
            // Poll 1: endpoint A serves a full tree and advances the cursor to 1000.
            axiosStub.post.withArgs('http://a:1').onFirstCall().resolves({ data: { result: {
                configs: { BTC: { mainnet: { 'xchain-indexer': { name: 'a' } } } }, seq: 1, watermark: 1000
            } } });
            // Poll 2: endpoint A is down; endpoint B serves a different full tree (wm 2000).
            axiosStub.post.withArgs('http://a:1').onSecondCall().rejects({ code: 'ECONNREFUSED' });
            axiosStub.post.withArgs('http://b:2').resolves({ data: { result: {
                configs: { LTC: { testnet: { 'xchain-indexer': { name: 'b' } } } }, seq: 2, watermark: 2000
            } } });
            const Connector = loadConnector(axiosStub);
            let c = new Connector(['http://a:1', 'http://b:2']);

            await c.getAllConfig();
            expect(c.lastWatermark).to.equal(1000);
            expect(c._watermarkEndpointIdx).to.equal(0);

            let second = await c.getAllConfig();
            let resetCall = axiosStub.post.getCalls().find(call =>
                call.args[0] === 'http://b:2' && call.args[1].params.since_updated_at === 0);
            expect(resetCall, 'expected a since_updated_at=0 re-fetch against the new endpoint').to.exist;
            // Full replace from B: A's cached branch is gone (not cross-hub merged).
            expect(second.LTC.testnet['xchain-indexer']).to.exist;
            expect(second.BTC).to.be.undefined;
            expect(c.lastWatermark).to.equal(2000);
            expect(c._watermarkEndpointIdx).to.equal(1);
        });
    });
}

function registerConfigResultRegression() {
    describe('applyConfigResult() and config-delta merge', function () {
        it('treats a regressed hub watermark as a hub reset: alarms, drops the cache and re-fetches the full tree', async function () {
            // Hub restored from an older snapshot: its MAX(updated_at) watermark goes
            // BACKWARDS. The delta against the lost-window cursor cannot carry rows the
            // restored hub holds at an older updated_at, and the upsert-only merge would
            // serve the lost-window value forever while config.js stamps the fetch fresh.
            const axiosStub = makeAxiosStub();
            // Poll 1: full tree, watermark 5000, cached value from the soon-to-be-lost window.
            axiosStub.post.onCall(0).resolves({ data: { result: {
                configs: { BTC: { mainnet: { 'xchain-indexer': { name: 'lost-window' } } } }, seq: 5, watermark: 5000
            } } });
            // Poll 2: delta at 4999 comes back empty with a LOWER watermark (3000).
            axiosStub.post.onCall(1).resolves({ data: { result: { configs: {}, seq: 3, watermark: 3000 } } });
            // Re-fetch at since 0: the restored hub's full tree.
            axiosStub.post.onCall(2).resolves({ data: { result: {
                configs: { BTC: { mainnet: { 'xchain-indexer': { name: 'restored' } } } }, seq: 3, watermark: 3000
            } } });
            const Connector = loadConnector(axiosStub);
            let c = new Connector(['http://localhost:3000']);
            await c.getAllConfig();
            expect(c.lastWatermark).to.equal(5000);

            const errStub = sinon.stub(console, 'error');
            let second;
            try {
                second = await c.getAllConfig();
            } finally {
                errStub.restore();
            }
            expect(axiosStub.post.getCall(1).args[1].params.since_updated_at).to.equal(4999);
            expect(axiosStub.post.getCall(2).args[1].params.since_updated_at).to.equal(0);
            // Replaced, not merged: the lost-window value is gone.
            expect(second.BTC.mainnet['xchain-indexer'].name).to.equal('restored');
            expect(c.lastWatermark).to.equal(3000);
            expect(c.lastSeq).to.equal(3);
            expect(errStub.calledWithMatch(/HUB_CONFIG_REGRESSION/)).to.equal(true);

            // Poll 3: steady state resumes as a delta against the new watermark.
            axiosStub.post.onCall(3).resolves({ data: { result: { configs: {}, seq: 3, watermark: 3000 } } });
            await c.getAllConfig();
            expect(axiosStub.post.getCall(3).args[1].params.since_updated_at).to.equal(2999);
            expect(axiosStub.post.callCount).to.equal(4);
        });
    });
}

function registerConfigResultEqualWatermark() {
    describe('applyConfigResult() and config-delta merge', function () {
        it('an equal (re-delivered) watermark is not a regression: no re-fetch, delta merged', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.onCall(0).resolves({ data: { result: {
                configs: { BTC: { mainnet: { fees: { a: '1' } } } }, seq: 1, watermark: 1000
            } } });
            axiosStub.post.onCall(1).resolves({ data: { result: {
                configs: { BTC: { mainnet: { fees: { b: '2' } } } }, seq: 1, watermark: 1000
            } } });
            const Connector = loadConnector(axiosStub);
            let c = new Connector(['http://localhost:3000']);
            await c.getAllConfig();
            let second = await c.getAllConfig();
            expect(second.BTC.mainnet.fees).to.deep.equal({ a: '1', b: '2' });
            expect(axiosStub.post.callCount).to.equal(2);
        });
    });
}

    // A JSON-RPC error body over HTTP 2xx is a definitive protocol-level answer
    // from a live hub (the hub's router answers -32601 this way for a method its
    // build does not serve). It must surface on lastRpcError for callers to
    // diagnose, and must not burn retry backoff: the answer is deterministic.
const RPC_ERROR = { data: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } } };

function registerRpcErrorAnswers() {
    describe('_call() JSON-RPC error answers', function () {
        it('records lastRpcError and gives up without retry passes on a -32601 answer', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves(RPC_ERROR);
            const Connector = loadConnector(axiosStub);
            const c = new Connector(['http://a:1']);
            const result = await c.call({ jsonrpc: '2.0', method: 'getslashproposals', id: 1 },
                { attempts: 3, delayMs: 0 });
            expect(result).to.equal(null);
            expect(c.lastRpcError).to.deep.equal({ code: -32601, message: 'Method not found' });
            expect(axiosStub.post.callCount, 'a deterministic answer must not be retried').to.equal(1);
            expect(c.lastFailures[0]).to.contain('-32601');
        });

        it('a later healthy call clears lastRpcError', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.onFirstCall().resolves(RPC_ERROR);
            axiosStub.post.onSecondCall().resolves({ data: { result: [] } });
            const Connector = loadConnector(axiosStub);
            const c = new Connector(['http://a:1']);
            await c.call({ jsonrpc: '2.0', method: 'getslashproposals', id: 1 }, { attempts: 1 });
            expect(c.lastRpcError).to.not.equal(null);
            await c.call({ jsonrpc: '2.0', method: 'getvotes', id: 1 }, { attempts: 1 });
            expect(c.lastRpcError).to.equal(null);
        });

        it('a network failure leaves lastRpcError null, so the outage diagnosis is untouched', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            const Connector = loadConnector(axiosStub);
            const c = new Connector(['http://a:1']);
            const result = await c.call({ jsonrpc: '2.0', method: 'getvotes', id: 1 }, { attempts: 2, delayMs: 0 });
            expect(result).to.equal(null);
            expect(c.lastRpcError).to.equal(null);
            expect(axiosStub.post.callCount, 'unreachable endpoints still get their retry passes').to.equal(2);
        });

        it('still walks the rest of the pass: a mixed fleet endpoint that serves the method wins', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.withArgs('http://a:1').resolves(RPC_ERROR);
            axiosStub.post.withArgs('http://b:2').resolves({ data: { result: [{ id: 1 }] } });
            const Connector = loadConnector(axiosStub);
            const c = new Connector(['http://a:1', 'http://b:2']);
            const result = await c.call({ jsonrpc: '2.0', method: 'getslashproposals', id: 1 }, { attempts: 1 });
            expect(result).to.deep.equal([{ id: 1 }]);
        });
    });
}

module.exports = [
    registerConfigResultBasics, registerConfigResultFailover,
    registerConfigResultRegression, registerConfigResultEqualWatermark,
    registerRpcErrorAnswers,
];
