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

const { sinon, expect, makeAxiosStub, loadConnector, degraded503Error } = require('./helpers.js');

function registerConstructor() {
    describe('constructor', function () {
        it('stores the endpoint URLs it was given', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            expect(connector.urls[0]).to.equal('http://localhost:3000');
        });

        it('keeps the port inside the endpoint URL', function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://127.0.0.1:8765']);
            expect(connector.urls[0]).to.include('8765');
        });

        it('throws on a non-array argument (the removed host+port form)', function () {
            const XChainHubConnector = loadConnector(makeAxiosStub());
            expect(() => new XChainHubConnector('localhost', 3000)).to.throw(TypeError, /array of URL strings/);
        });
    });
}

function registerPingSuccesses() {
    describe('ping()', function () {
        it('returns true when the response contains a result', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.true;
        });

        it('POSTs a JSON-RPC ping payload to the connector URL', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: 'pong' } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            await connector.ping();
            const [url, payload] = axiosStub.post.firstCall.args;
            expect(url).to.equal('http://localhost:3000');
            expect(payload).to.deep.include({ method: 'ping' });
        });

        it('returns false when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.false;
        });
    });
}

function registerPingFailures() {
    describe('ping()', function () {
        it('returns false when the result field is falsy', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: null } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns false on a network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.false;
        });

        it('returns true (reachable) for a 503 "degraded" hub rather than masking it as down', async function () {
            // A live hub with a dead DB pool must NOT read the same as a crashed one.
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(degraded503Error());
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.true;
        });
    });
}

function registerGetAllConfigResponses() {
    describe('getAllConfig()', function () {
        it('returns the result data on a successful response', async function () {
            const mockResult = { bitcoin: { mainnet: { indexer: {}, decoder: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: mockResult } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
        });

        it('POSTs a JSON-RPC getallconfigs payload with a 5000ms timeout', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: {} } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
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
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null on a general network error', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('logs the error message when the request fails', async function () {
            const axiosStub    = makeAxiosStub();
            // Source uses console.warn (not console.error) for per-endpoint failures
            const consoleStub  = sinon.stub(console, 'warn');
            axiosStub.post.rejects(new Error('network down'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            await connector.getAllConfig();
            // With multi-attempt retry, warn is called multiple times; just check it fired
            expect(consoleStub.called).to.be.true;
            expect(consoleStub.firstCall.args.join(' ')).to.include('network down');
            consoleStub.restore();
        });
    });
}

function registerGetAllConfigErrors() {
    describe('getAllConfig()', function () {
        it('returns null when the response has no result field', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: {} });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('returns null (not the degraded body) when the hub reports 503 degraded', async function () {
            // A {status:"degraded"} body is not a config tree; config.js must fall
            // back to its cache rather than iterate the degraded object as config.
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(degraded503Error());
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
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
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.be.null;
        });

        it('unwraps a { configs, seq } response to the bare map and records lastSeq', async function () {
            const configs   = { bitcoin: { mainnet: { indexer: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { configs, seq: 7 } } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            // Caller still sees the bare nested map, not the wrapper.
            expect(result).to.deep.equal(configs);
            expect(connector.lastSeq).to.equal(7);
        });
    });
}

function registerGetAllConfigCursor() {
    describe('getAllConfig()', function () {
        it('treats a bare-map response (older hub) as seq 0', async function () {
            const configs   = { bitcoin: { mainnet: { indexer: {} } } };
            const axiosStub  = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: configs } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(configs);
            expect(connector.lastSeq).to.equal(0);
        });

        it('sends the cursor one second behind the stored watermark (same-second row skip fix)', async function () {
            // The hub reads its watermark BEFORE reading config rows, with a strict
            // `since_updated_at > cursor` filter, so a row committed in the watermark's
            // epoch-second is never re-delivered once our cursor advances past it.
            // Sending lastWatermark-1 re-fetches that boundary second every poll;
            // mergeConfigDelta's upsert-only merge makes the overlap a no-op re-apply.
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { configs: {}, seq: 1, watermark: 1000 } } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            connector.lastWatermark = 1000;

            await connector.getAllConfig();

            const [, payload] = axiosStub.post.firstCall.args;
            expect(payload.params.since_updated_at).to.equal(999);
        });

        it('still sends since_updated_at=0 for the initial fetch (no lookback when watermark is 0)', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { configs: {}, seq: 1, watermark: 1000 } } });
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);

            await connector.getAllConfig();

            const [, payload] = axiosStub.post.firstCall.args;
            expect(payload.params.since_updated_at).to.equal(0);
        });
    });
}

function registerGetAllConfigBoundary() {
    describe('getAllConfig()', function () {
        it('re-merging the same boundary-second row on the next poll does not lose or duplicate it', async function () {
            const axiosStub = makeAxiosStub();
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            connector.lastWatermark = 1000;
            connector.configs       = { bitcoin: { mainnet: { indexer: { a: 1 } } } };

            // Same row (indexer.a) re-delivered because it falls inside the
            // one-second lookback window; merge must be idempotent.
            axiosStub.post.resolves({
                data: { result: { configs: { bitcoin: { mainnet: { indexer: { a: 1, b: 2 } } } }, seq: 2, watermark: 1000 } }
            });

            const result = await connector.getAllConfig();
            expect(result.bitcoin.mainnet.indexer).to.deep.equal({ a: 1, b: 2 });
        });
    });
}

module.exports = [
    registerConstructor, registerPingSuccesses, registerPingFailures,
    registerGetAllConfigResponses, registerGetAllConfigErrors,
    registerGetAllConfigCursor, registerGetAllConfigBoundary,
];
