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

// Hub operational-state cache (validator_capabilities / governance_proposals /
// governance_votes over hub JSON-RPC) and the RPC-first read path in db/index.js:
// TTL/stale cache behavior, endpoint resolution, filter param mapping, and JS
// paging parity with the SQL cursor semantics it replaces.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig }           = require('../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// Load HubOperationalCache with a stubbed connector class so no HTTP happens.
// `rpc` is a mutable box: set rpc.error to emulate the connector recording a
// definitive JSON-RPC error answer (lastRpcError) for the calls that follow.
function loadCache({ callResult, rpcError, env = {} } = {}) {
    const callStub = sinon.stub().resolves(callResult === undefined ? [] : callResult);
    const rpc = { error: rpcError || null };
    class FakeConnector {
        constructor(endpoints) {
            this.urls = endpoints;
            this.lastRpcError = null;
            this.call = (data, opts) => {
                this.lastRpcError = rpc.error;
                // The real connector writes the answer onto the caller's
                // call-scoped sink as well; getRows now reads only that.
                if (opts && opts.out) opts.out.rpcError = rpc.error;
                return callStub(data, opts);
            };
        }
    }
    FakeConnector.parseEndpoints = () =>
        ['1', 'true', 'yes'].includes(String(env.NO_HUB || '').toLowerCase())
            ? null : ['http://hub.test:10000'];

    const saved = {};
    for (const k of ['HUB_API_URL', 'NO_HUB', 'EXPLORER_HUB_CACHE_MS', 'EXPLORER_HUB_CACHE_STALE_MAX_MS']) {
        saved[k] = process.env[k];
        if (env[k] !== undefined) process.env[k] = env[k];
        else delete process.env[k];
    }
    const HubOperationalCache = proxyquire('../../../src/mirror/operational_cache.js', {
        '../connectors/hub': FakeConnector
    });
    const cache = new HubOperationalCache({ util });
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return { cache, callStub, rpc };
}

/**
 * Seed one cached row set, age it, then fail an RPC that itself consumes
 * `rpcMs` of clock while it runs.
 */
async function serveAfterOutage({ ceilingMs, ageMs, rpcMs }) {
    const clock = sinon.useFakeTimers();
    try {
        const { cache, callStub } = loadCache({
            callResult: [{ id: 7 }],
            env: {
                EXPLORER_HUB_CACHE_MS: '1000',
                EXPLORER_HUB_CACHE_STALE_MAX_MS: String(ceilingMs),
            },
        });
        await cache.getRows('getproposals', {});
        clock.tick(ageMs);
        // An unreachable hub: the retries take real time, then answer null.
        callStub.callsFake(async () => { clock.tick(rpcMs); return null; });
        return await cache.getRows('getproposals', {});
    } finally { clock.restore(); }
}

function makeDb(hubOperational) {
    return new Database({ configInfo, util, hubOperational });
}

function rows(n) {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

function listConfig(method, overrides = {}) {
    return makeConfig({ type: 'explorer', data: { method, ...overrides } });
}

function makeRpcDispatchFixture() {
    const ops = {
        enabled: () => true,
        getValidatorCapabilities: sinon.stub().resolves([{ id: 3, capability: 'price' }])
    };
    const db = makeDb(ops);
    const cfg = listConfig('getValidatorCapabilities', { search: 'price', type: 'capability' });
    return { ops, db, cfg };
}

module.exports = {
    sinon, expect, loadCache, serveAfterOutage, makeDb, rows, listConfig,
    makeRpcDispatchFixture, makeConfig
};
