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

const { expect, makeAxiosStub, loadConnector } = require('./helpers.js');

    // Retries bridge the startup race where the hub is still booting.
function registerRetryBehavior() {
    describe('getAllConfig() retry behavior', function () {
        it('retries the endpoint pass HUB_RETRY_ATTEMPTS times before returning null', async function () {
            const savedAttempts = process.env.HUB_RETRY_ATTEMPTS;
            process.env.HUB_RETRY_ATTEMPTS = '4';
            try {
                const axiosStub = makeAxiosStub();
                axiosStub.post.rejects(new Error('ECONNREFUSED'));
                const XChainHubConnector = loadConnector(axiosStub);
                const connector = new XChainHubConnector(['http://localhost:3000']);
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
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.getAllConfig();
            expect(result).to.deep.equal(mockResult);
            expect(axiosStub.post.callCount).to.equal(2);
        });

        it('ping() does not retry: a single attempt only', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            const XChainHubConnector = loadConnector(axiosStub);
            const connector = new XChainHubConnector(['http://localhost:3000']);
            const result = await connector.ping();
            expect(result).to.be.false;
            expect(axiosStub.post.callCount).to.equal(1);
        });
    });
}

// A hub outage under load must not log in proportion to request rate.
function registerOutageLogThrottle() {
    describe('hub outage warn throttle', function () {
        const WARN_EVENTS = ['HUB_ENDPOINT_FAILED', 'HUB_ENDPOINTS_UNREACHABLE'];

        function makeLogger() {
            const lines = [];
            const logger = {
                warn: (event, fields) => lines.push({ event, fields }),
                info() {}, error() {}, debug() {}
            };
            return { logger, lines };
        }

        async function burst(n) {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            const { logger, lines } = makeLogger();
            const XChainHubConnector = loadConnector(axiosStub, logger);
            const connector = new XChainHubConnector(['http://127.0.0.1:1']);
            const outs = Array.from({ length: n }, () => ({}));
            const results = await Promise.all(outs.map((out) =>
                connector.call({ jsonrpc: '2.0', method: 'x', id: 1 }, { out })));
            return { connector, lines, outs, results, axiosStub };
        }

        it('bounds warn lines per window independent of concurrent call count', async function () {
            const small = await burst(10);
            const large = await burst(100);
            const count = (r) => r.lines.filter((l) => WARN_EVENTS.includes(l.event)).length;
            expect(count(large)).to.equal(count(small));
            expect(count(large)).to.be.at.most(4);
            expect(count(large)).to.be.greaterThan(0);
        });

        it('keeps the stack on the first line only and still records every failure', async function () {
            const r = await burst(50);
            const failed = r.lines.filter((l) => l.event === 'HUB_ENDPOINT_FAILED');
            expect(failed[0].fields.stack).to.be.a('string');
            for (const l of failed.slice(1)) expect(l.fields.stack).to.equal(undefined);
            for (const out of r.outs) expect(out.failures.length).to.equal(1);
            expect(r.connector.lastFailures.length).to.equal(1);
            expect(r.results.every((v) => v === null)).to.equal(true);
            expect(r.axiosStub.post.callCount).to.equal(50 * 4);
        });

        it('reports the suppressed count on the next window line', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            const { logger, lines } = makeLogger();
            const XChainHubConnector = loadConnector(axiosStub, logger);
            const connector = new XChainHubConnector(['http://127.0.0.1:1']);
            const nowStub = sinon_stubNow(1000000);
            try {
                await Promise.all(Array.from({ length: 20 }, () =>
                    connector.call({ jsonrpc: '2.0', method: 'x', id: 1 })));
                const before = lines.filter((l) => l.event === 'HUB_ENDPOINT_FAILED').length;
                nowStub.set(1000000 + 120000);
                await connector.call({ jsonrpc: '2.0', method: 'x', id: 1 });
                const failed = lines.filter((l) => l.event === 'HUB_ENDPOINT_FAILED');
                const next = failed[before];
                expect(next, 'a line in the next window').to.exist;
                // 20 calls x 4 attempts = 80 failures in window one, 1 emitted.
                expect(next.fields.suppressed).to.equal(80 - before);
            } finally {
                nowStub.restore();
            }
        });
    });
}

function sinon_stubNow(start) {
    const { sinon } = require('./helpers.js');
    let t = start;
    const stub = sinon.stub(Date, 'now').callsFake(() => t);
    return { set: (v) => { t = v; }, restore: () => stub.restore() };
}

    // Where the explorer looks for a hub: the host/port overrides, an explicit
    // validator list, or standalone mode, where there is no hub at all and the local
    // config file drives configuration instead.
        const HUB_ENV = ['NO_HUB', 'HUB_VALIDATORS', 'HUB_API_HOST', 'HUB_PORT'];
        let saved;

function registerEndpointModes() {
    describe('parseEndpoints()', function () {
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
            const XChainHubConnector = require('../../../../../src/connectors/hub');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://localhost:10000']);
        });

        it('honours HUB_API_HOST / HUB_PORT overrides', function () {
            process.env.HUB_API_HOST = 'hub.example.com';
            process.env.HUB_PORT     = '9999';
            const XChainHubConnector = require('../../../../../src/connectors/hub');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://hub.example.com:9999']);
        });

        it('splits HUB_VALIDATORS into a normalised endpoint list', function () {
            process.env.HUB_VALIDATORS = 'http://a:10000, b:10000 ,';
            const XChainHubConnector = require('../../../../../src/connectors/hub');
            expect(XChainHubConnector.parseEndpoints()).to.deep.equal(['http://a:10000', 'http://b:10000']);
        });

        it('returns null in standalone mode (NO_HUB=1) so config.json drives config', function () {
            process.env.NO_HUB = '1';
            const XChainHubConnector = require('../../../../../src/connectors/hub');
            expect(XChainHubConnector.parseEndpoints()).to.be.null;
        });
    });
}

function registerEndpointEnvironment() {
    describe('parseEndpoints()', function () {
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

        it('NO_HUB accepts true/yes and takes precedence over HUB_VALIDATORS', function () {
            process.env.HUB_VALIDATORS = 'http://a:10000';
            for (const v of ['1', 'true', 'TRUE', 'yes']) {
                process.env.NO_HUB = v;
                const XChainHubConnector = require('../../../../../src/connectors/hub');
                expect(XChainHubConnector.parseEndpoints(), 'NO_HUB=' + v).to.be.null;
            }
        });

        it('does not disable the hub for falsy NO_HUB values', function () {
            for (const v of ['0', 'false', 'no', '']) {
                process.env.NO_HUB = v;
                const XChainHubConnector = require('../../../../../src/connectors/hub');
                expect(XChainHubConnector.parseEndpoints(), 'NO_HUB=' + JSON.stringify(v))
                    .to.deep.equal(['http://localhost:10000']);
            }
        });

        it('reads its env when config.js is loaded first, the order api.js boots in', function () {
            // config.js requires this connector at its top, before config.js has built
            // its exports. A connector that captured config.js's env view at load would
            // hold undefined and throw here. Run in a child process because this mocha
            // process has long since cached both modules.
            const { spawnSync } = require('child_process');
            const path = require('path');
            const script = "require('./src/config.js');" +
                "process.stdout.write('\\nENDPOINTS=' + JSON.stringify(require('./src/connectors/hub.js').parseEndpoints()) + '\\n');";
            const run = spawnSync(process.execPath, ['-e', script], {
                cwd: path.resolve(__dirname, '..', '../../../..'), encoding: 'utf8',
                env: { ...process.env, XCHAIN_LOG_PATCH: '0', NO_HUB: '', HUB_VALIDATORS: 'a:1' }
            });
            expect(run.status, run.stderr).to.equal(0);
            const line = run.stdout.split('\n').find((l) => l.startsWith('ENDPOINTS='));
            expect(JSON.parse(line.slice('ENDPOINTS='.length))).to.deep.equal(['http://a:1']);
        });
    });
}

module.exports = [registerRetryBehavior, registerOutageLogThrottle, registerEndpointModes, registerEndpointEnvironment];
