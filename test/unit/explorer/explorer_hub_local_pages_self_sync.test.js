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

// The four hub-local operational tables (p2p_peers, consensus_state, configs,
// telemetry_pings) are read from the coin's checkpoint schema. On a self-synced
// install that schema is the explorer's own hub mirror, which never replicates
// these tables, so the read can only fail with "table doesn't exist". The route
// must refuse with a typed 503 before any query runs, never answer 500 DB_ERROR.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../../fixtures/mock-query-args.js');

const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB { constructor() {} async init() {} }

const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
    'express': express,
    './db/index.js': MockDB,
    'fs': { existsSync: () => true, readFileSync: () => 'mock' }
});

const OK_STATUS = {
    enabled: true, target: { host: 'db1', name: 'XChain_Hub_Mirror' },
    bootstrapDrained: true, everBootstrapped: true, streamWatermark: 1000, mirrorLagSeconds: 5
};

const NO_TABLE = 'HUB_LOCAL_TABLE_NOT_MIRRORED';

// What MariaDB answers for a table that is not in the schema.
function missingTableError() {
    const e = new Error("Table 'XChain_Hub_Mirror.configs' doesn't exist");
    e.errno = 1146;
    e.code  = 'ER_NO_SUCH_TABLE';
    return e;
}

// mirrorStatus null: the coin reads an externally maintained checkpoint schema
// (a co-located hub DB), so this process runs no mirror for it.
function routedExplorer(mirrorStatus, getData) {
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    explorer.db.pools = { BTC: {} };
    explorer.hubMirrorSync = {
        managesCoin: (c) => c === 'BTC' && mirrorStatus !== null,
        statusForCoin: () => mirrorStatus
    };
    explorer.db.getMaxMethodResults = () => 100;
    explorer.db.getCoinFreshness = async () => null;
    explorer.db.getData = getData || sinon.stub().rejects(missingTableError());
    return explorer;
}

async function get(explorer, path) {
    const res = mockRes();
    await explorer.processRequest(mockReq(path, {}), res);
    return res;
}

function bodyOf(res) {
    return typeof res._body === 'string' ? JSON.parse(res._body) : res._body;
}

function loggedQueryFailure(spy) {
    return spy.getCalls().some(c => c.args.some(a => /QUERY_FAILED/.test(String(a))));
}

describe('hub-local operational pages on a self-synced hub mirror', function () {
    afterEach(function () { sinon.restore(); });

    const routes = [
        '/BTC/api/peers',
        '/BTC/api/consensus_state',
        '/BTC/api/configs',
        '/BTC/api/telemetry_pings',
        '/BTC/api/configs/BTC/coin',
        '/BTC/api/telemetry_pings/heartbeat/event'
    ];

    for (const path of routes) {
        it(`${path}: typed 503, no query, no failed-query log`, async function () {
            const errSpy = sinon.stub(console, 'error');
            const explorer = routedExplorer(OK_STATUS);
            const res = await get(explorer, path);
            const body = bodyOf(res);
            expect(res._status).to.equal(503);
            expect(body.code).to.equal(NO_TABLE);
            expect(body.code).to.not.equal('DB_ERROR');
            expect(body.error).to.match(/hub-local/i);
            expect(body.error).to.match(/co-located hub DB/);
            expect(explorer.db.getData.notCalled).to.equal(true);
            expect(loggedQueryFailure(errSpy)).to.equal(false);
        });
    }

    it('refuses the same way while the mirror is unconfigured or not yet bootstrapped', async function () {
        for (const status of [{ ...OK_STATUS, configured: false },
                              { ...OK_STATUS, bootstrapDrained: false, everBootstrapped: false }]) {
            const explorer = routedExplorer(status);
            const res = await get(explorer, '/BTC/api/configs');
            expect(res._status).to.equal(503);
            expect(bodyOf(res).code).to.equal(NO_TABLE);
            expect(explorer.db.getData.notCalled).to.equal(true);
        }
    });
});

describe('hub-local operational pages: routes the refusal must not touch', function () {
    afterEach(function () { sinon.restore(); });

    it('still reads the co-located hub DB when the coin is not self-synced', async function () {
        const getData = sinon.stub().resolves([[{ id: 7, coin: 'BTC', module: 'core' }], 1]);
        const explorer = routedExplorer(null, getData);
        const res = await get(explorer, '/BTC/api/configs');
        expect(getData.calledOnce).to.equal(true);
        expect(getData.firstCall.args[0].data.method).to.equal('getConfigs');
        expect(res._status).to.not.equal(503);
        const body = bodyOf(res);
        expect(body.total).to.equal(1);
        expect(body).to.not.have.property('mirror_bootstrapped');
    });

    it('leaves the mirror-gated cross-chain route on its staleness gate', async function () {
        const blocked = await get(routedExplorer({ ...OK_STATUS, bootstrapDrained: false, everBootstrapped: false },
            sinon.stub().resolves([[], 0])), '/BTC/api/cross_chain_matches');
        expect(blocked._status).to.equal(503);
        expect(bodyOf(blocked).code).to.equal('MIRROR_NOT_BOOTSTRAPPED');

        const getData = sinon.stub().resolves([[{ id: 1 }], 1]);
        const served = await get(routedExplorer(OK_STATUS, getData), '/BTC/api/cross_chain_matches');
        expect(served._status).to.not.equal(503);
        expect(getData.calledOnce).to.equal(true);
        expect(bodyOf(served).mirror_lag_seconds).to.equal(5);
    });

    it('leaves a non-mirror route (tokens) ungated', async function () {
        const getData = sinon.stub().resolves([[{ id: 1 }], 1]);
        const res = await get(routedExplorer(OK_STATUS, getData), '/BTC/api/tokens');
        expect(res._status).to.not.equal(503);
        expect(getData.calledOnce).to.equal(true);
    });
});
