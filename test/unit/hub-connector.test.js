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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

// Collapse retry backoff to zero so the retry-path tests run instantly.
// The connector reads this env var in its constructor.
process.env.HUB_RETRY_DELAY_MS = '0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxiosStub() {
    return { post: sinon.stub() };
}

function loadConnector(axiosStub) {
    return proxyquire('../../src/XChainHubConnector', {
        'axios': axiosStub
    });
}

// Axios-style error for a non-2xx response that still carries a valid JSON-RPC
// body (e.g. the hub's HTTP 503 "degraded" health response when its DB pool is
// down). Axios attaches the full response to the thrown error as err.response.
function degraded503Error(body) {
    const err = new Error('Request failed with status code 503');
    err.response = {
        status: 503,
        data: { jsonrpc: '2.0', id: 1, result: body || { status: 'degraded', db: false } }
    };
    return err;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('XChainHubConnector', function () {

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', function () {

        it('builds the URL as http://<url>:<port>', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            // Source was refactored to multi-endpoint: single host+port is stored as urls[0]
            expect(connector.urls[0]).to.equal('http://localhost:3000');
        });

        it('stores the port on the instance', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('127.0.0.1', 8765);
            // Port is captured inside urls[0] after the multi-endpoint refactor
            expect(connector.urls[0]).to.include('8765');
        });

    });

    // -----------------------------------------------------------------------
    // ping()
    // -----------------------------------------------------------------------

    describe('ping()', function () {

        it('returns true when the response contains a result', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.true;
        });

        it('POSTs a JSON-RPC ping payload to the connector URL', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.ping();
            const [url, payload] = axiosStub.post.firstCall.args;
            expect(url).to.equal('http://localhost:3000');
            expect(payload).to.deep.include({ method: 'ping' });
        });

        it('returns false when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns false when the result field is falsy', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: null } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns false on a network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns true (reachable) for a 503 "degraded" hub rather than masking it as down', async function () {
            // A live hub with a dead DB pool must NOT read the same as a crashed one.
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(degraded503Error());
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.true;
        });

    });

    // -----------------------------------------------------------------------
    // getAllConfig()
    // -----------------------------------------------------------------------

    describe('getAllConfig()', function () {

        it('returns the result data on a successful response', async function () {
            const mockResult = { bitcoin: { mainnet: { indexer: {}, decoder: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: mockResult } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
        });

        it('POSTs a JSON-RPC getallconfigs payload with a 5000ms timeout', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.getAllConfig();
            const [, payload, options] = axiosStub.post.firstCall.args;
            expect(payload).to.deep.include({ method: 'getallconfigs' });
            expect(options).to.deep.include({ timeout: 5000 });
        });

        it('returns null on a timeout error', async function () {
            const axiosStub = makeAxiosStub();
            const timeoutErr = new Error('timeout of 5000ms exceeded');
            timeoutErr.code  = 'ECONNABORTED';
            axiosStub.post.rejects(timeoutErr);
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null on a general network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('logs the error message when the request fails', async function () {
            const axiosStub    = makeAxiosStub();
            // Source uses console.warn (not console.error) for per-endpoint failures
            const consoleStub  = sinon.stub(console, 'warn');
            axiosStub.post.rejects(new Error('network down'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            await connector.getAllConfig();
            // With multi-attempt retry, warn is called multiple times; just check it fired
            expect(consoleStub.called).to.be.true;
            expect(consoleStub.firstCall.args.join(' ')).to.include('network down');
            consoleStub.restore();
        });

        it('returns null when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null (not the degraded body) when the hub reports 503 degraded', async function () {
            // A {status:"degraded"} body is not a config tree; config.js must fall
            // back to its cache rather than iterate the degraded object as config.
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(degraded503Error());
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null (not the {error} envelope) when the hub reports a config-DB read error', async function () {
            // getallconfigs signals a config-DB read failure as an HTTP-200 { error: ... }
            // *result*; config.js must fall back to cache and leave its staleness timestamp
            // unrefreshed rather than iterate the one-key error object down to zero coins.
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { error: 'there was an error trying to get all configs' } } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('unwraps a { configs, seq } response to the bare map and records lastSeq', async function () {
            const configs   = { bitcoin: { mainnet: { indexer: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { configs, seq: 7 } } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            // Caller still sees the bare nested map, not the wrapper.
            expect(result).to.deep.equal(configs);
            expect(connector.lastSeq).to.equal(7);
        });

        it('treats a bare-map response (older hub) as seq 0', async function () {
            const configs   = { bitcoin: { mainnet: { indexer: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: configs } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(configs);
            expect(connector.lastSeq).to.equal(0);
        });

    });

    // -----------------------------------------------------------------------
    // Retry behavior: bridges the startup race where the hub is still booting
    // -----------------------------------------------------------------------

    describe('getAllConfig() retry behavior', function () {

        it('retries the endpoint pass HUB_RETRY_ATTEMPTS times before returning null', async function () {
            const savedAttempts = process.env.HUB_RETRY_ATTEMPTS;
            process.env.HUB_RETRY_ATTEMPTS = '4';
            try {
                const axiosStub = makeAxiosStub();
                axiosStub.post.rejects(new Error('ECONNREFUSED'));
                const XChainHubConnector = loadConnector(axiosStub);
                const connector = new XChainHubConnector('localhost', 3000);
                const result = await connector.getAllConfig();
                expect(result).to.be.null;
                // One endpoint × 4 attempts
                expect(axiosStub.post.callCount).to.equal(4);
            } finally {
                if (savedAttempts !== undefined) process.env.HUB_RETRY_ATTEMPTS = savedAttempts;
                else delete process.env.HUB_RETRY_ATTEMPTS;
            }
        });

        it('returns the result once an endpoint recovers on a later attempt', async function () {
            const mockResult = { bitcoin: { mainnet: { indexer: {}, decoder: {} } } };
            const axiosStub  = makeAxiosStub();
            // First pass fails, second pass succeeds: the hub finished booting.
            axiosStub.post.onFirstCall().rejects(new Error('ECONNREFUSED'));
            axiosStub.post.onSecondCall().resolves({ data: { result: mockResult } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
            expect(axiosStub.post.callCount).to.equal(2);
        });

        it('ping() does not retry: a single attempt only', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector('localhost', 3000);
            const result = await connector.ping();
            expect(result).to.be.false;
            expect(axiosStub.post.callCount).to.equal(1);
        });

    });

    // -----------------------------------------------------------------------
    // parseEndpoints(): hub discovery vs. standalone (NO_HUB) mode
    // -----------------------------------------------------------------------
    describe('parseEndpoints()', function () {

        const HUB_ENV = ['NO_HUB', 'HUB_VALIDATORS', 'HUB_API_HOST', 'HUB_PORT'];
        let saved;

        beforeEach(function () {
            saved = {};
            for (const k of HUB_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
        });
        afterEach(function () {
            for (const k of HUB_ENV) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        });

        it('defaults to the local hub on localhost:10000 when nothing is set', function () {
            const XChainHubConnector = require('../../src/XChainHubConnector');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://localhost:10000']);
        });

        it('honours HUB_API_HOST / HUB_PORT overrides', function () {
            process.env.HUB_API_HOST = 'hub.example.com';
            process.env.HUB_PORT     = '9999';
            const XChainHubConnector = require('../../src/XChainHubConnector');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://hub.example.com:9999']);
        });

        it('splits HUB_VALIDATORS into a normalised endpoint list', function () {
            process.env.HUB_VALIDATORS = 'http://a:10000, b:10000 ,';
            const XChainHubConnector = require('../../src/XChainHubConnector');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://a:10000', 'http://b:10000']);
        });

        it('returns null in standalone mode (NO_HUB=1) so config.json drives config', function () {
            process.env.NO_HUB = '1';
            const XChainHubConnector = require('../../src/XChainHubConnector');
            expect(XChainHubConnector.parseEndpoints()).to.be.null;
        });

        it('NO_HUB accepts true/yes and takes precedence over HUB_VALIDATORS', function () {
            process.env.HUB_VALIDATORS = 'http://a:10000';
            for (const v of ['1', 'true', 'TRUE', 'yes']) {
                process.env.NO_HUB = v;
                const XChainHubConnector = require('../../src/XChainHubConnector');
                expect(XChainHubConnector.parseEndpoints(), 'NO_HUB=' + v).to.be.null;
            }
        });

        it('does not disable the hub for falsy NO_HUB values', function () {
            for (const v of ['0', 'false', 'no', '']) {
                process.env.NO_HUB = v;
                const XChainHubConnector = require('../../src/XChainHubConnector');
                expect(XChainHubConnector.parseEndpoints(), 'NO_HUB=' + JSON.stringify(v))
                    .to.deep.equal(['http://localhost:10000']);
            }
        });

    });

    // -----------------------------------------------------------------------
    // _applyConfigResult() + delta merge + array constructor
    // -----------------------------------------------------------------------

    describe('_applyConfigResult() and config-delta merge', function () {

        it('accepts an array of endpoint URLs directly', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector(['http://a:1', 'http://b:2']);
            expect(c.urls).to.deep.equal(['http://a:1', 'http://b:2']);
        });

        it('replaces with the full tree for a bare-map result (legacy hub)', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector('localhost', 3000);
            let tree = { BTC: { mainnet: { mod: { p: '1' } } } };
            let out = c._applyConfigResult(tree);
            expect(out).to.deep.equal(tree);
            expect(c.lastSeq).to.equal(0);
            expect(c.lastWatermark).to.equal(0);
        });

        it('resets the cursor when the hub reports no watermark', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector('localhost', 3000);
            c.lastWatermark = 50;
            let out = c._applyConfigResult({ configs: { BTC: {} }, seq: 7 });
            expect(c.lastSeq).to.equal(7);
            expect(c.lastWatermark).to.equal(0);
            expect(out).to.deep.equal({ BTC: {} });
        });

        it('returns the full payload on the first watermarked fetch', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector('localhost', 3000);
            let out = c._applyConfigResult({ configs: { BTC: { mainnet: {} } }, seq: 1, watermark: 1000 });
            expect(c.lastWatermark).to.equal(1000);
            expect(out).to.deep.equal({ BTC: { mainnet: {} } });
        });

        it('merges a delta into the cached tree on a subsequent watermarked fetch', function () {
            const Connector = loadConnector(makeAxiosStub());
            let c = new Connector('localhost', 3000);
            c.configs = { BTC: { mainnet: { fees: { a: '1' } } } };
            c.lastWatermark = 1000; // we sent a cursor last time
            let out = c._applyConfigResult({
                configs: { BTC: { mainnet: { fees: { b: '2' }, oracle: { x: '9' } }, regtest: { m: { p: '3' } } } },
                seq: 2, watermark: 2000
            });
            expect(c.lastWatermark).to.equal(2000);
            expect(out.BTC.mainnet.fees).to.deep.equal({ a: '1', b: '2' }); // existing kept, new merged
            expect(out.BTC.mainnet.oracle).to.deep.equal({ x: '9' });        // new module folded in
            expect(out.BTC.regtest.m).to.deep.equal({ p: '3' });             // new network folded in
        });

        it('resets the cursor and re-fetches full when it fails over to a different endpoint', async function () {
            // A wall-clock cursor from hub A is not valid against hub B (each stamps
            // updated_at at its own apply time), so on failover the connector must discard
            // the stale-cursor delta and re-fetch the full tree from the new endpoint.
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

});
