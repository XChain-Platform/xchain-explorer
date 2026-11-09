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
    bootstrapDrained: true, streamWatermark: 1000, mirrorLagSeconds: 5
};

function makeExplorer(mirrorStatus) {
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    explorer.db.pools = { BTC: {} };
    explorer.hubMirrorSync = {
        managesCoin: (c) => c === 'BTC' && mirrorStatus !== null,
        statusForCoin: () => mirrorStatus
    };
    return explorer;
}

// getOraclePrices reads the mirror-only oracle_prices table, so the full request
// path (not just the gate helper) must refuse or annotate it like the sibling
// cross-chain match route does.
describe('explorer hub-mirror gate on the oracle_prices route', function () {
    afterEach(function () {
        sinon.restore();
    });

    function routedExplorer(mirrorStatus) {
        const explorer = makeExplorer(mirrorStatus);
        explorer.db.getMaxMethodResults = () => 100;
        explorer.db.getData = sinon.stub().resolves([[{ id: 1 }], null]);
        explorer.db.getCoinFreshness = async () => null;
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

    it('503 MIRROR_NOT_BOOTSTRAPPED before the first bootstrap', async function () {
        const res = await get(routedExplorer({ ...OK_STATUS, bootstrapDrained: false }), '/BTC/api/oracle_prices');
        expect(res._status).to.equal(503);
        expect(bodyOf(res).code).to.equal('MIRROR_NOT_BOOTSTRAPPED');
    });

    it('annotates mirror lag once bootstrapped', async function () {
        const res = await get(routedExplorer(OK_STATUS), '/BTC/api/oracle_prices');
        expect(res._status).to.not.equal(503);
        const body = bodyOf(res);
        expect(body.mirror_bootstrapped).to.equal(true);
        expect(body.mirror_lag_seconds).to.equal(5);
    });

    it('adds no mirror fields for a coin the sync manager does not manage', async function () {
        const res = await get(routedExplorer(null), '/BTC/api/oracle_prices');
        expect(bodyOf(res)).to.not.have.property('mirror_bootstrapped');
        expect(bodyOf(res)).to.not.have.property('mirror_lag_seconds');
    });

    it('leaves a non-mirror method (getTokens) ungated', async function () {
        const res = await get(routedExplorer({ ...OK_STATUS, bootstrapDrained: false }), '/BTC/api/tokens');
        expect(res._status).to.not.equal(503);
        expect(bodyOf(res)).to.not.have.property('mirror_bootstrapped');
    });
});
