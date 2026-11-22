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

function registerResultErrorFailover() {
    describe('result error failover', function () {
        it('continues to a healthy endpoint without pinning the degraded endpoint', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.onFirstCall().resolves({ data: { result: { error: 'read failed' } } });
            axiosStub.post.onSecondCall().resolves({ data: { result: [{ id: 1 }] } });
            const Connector = loadConnector(axiosStub);
            const connector = new Connector(['first', 'second']);
            const result = await connector.call({ method: 'read' });
            expect(result).to.deep.equal([{ id: 1 }]);
            expect(axiosStub.post.callCount).to.equal(2);
            expect(connector._lastGoodIdx).to.equal(1);
        });

        it('returns the envelope after one complete answered pass', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.resolves({ data: { result: { error: 'read failed' } } });
            const Connector = loadConnector(axiosStub);
            const connector = new Connector(['first', 'second']);
            const out = {};
            const result = await connector.call({ method: 'read' }, { out });
            expect(result).to.deep.equal({ error: 'read failed' });
            expect(axiosStub.post.callCount).to.equal(2);
            expect(connector._lastGoodIdx).to.equal(0);
            expect(out.failures).to.have.length(2);
            expect(out.allEndpointsAnswered).to.equal(false);
        });

        it('does not turn a mixed error pass into a fleet capability answer', async function () {
            const axiosStub = makeAxiosStub();
            axiosStub.post.onFirstCall().resolves({ data: { error: { code: -32601, message: 'missing' } } });
            axiosStub.post.onSecondCall().resolves({ data: { result: { error: 'read failed' } } });
            const Connector = loadConnector(axiosStub);
            const out = {};
            await new Connector(['first', 'second']).call({ method: 'read' }, { out });
            expect(axiosStub.post.callCount).to.equal(2);
            expect(out.allEndpointsAnswered).to.equal(false);
        });
    });
}

function registerConfigResultErrorFailover() {
    describe('config result error failover', function () {
        it('uses a healthy config result after an error envelope', async function () {
            const configs = { bitcoin: { mainnet: { indexer: {} } } };
            const axiosStub = makeAxiosStub();
            axiosStub.post.onFirstCall().resolves({ data: { result: { error: 'config read failed' } } });
            axiosStub.post.onSecondCall().resolves({ data: { result: configs } });
            const Connector = loadConnector(axiosStub);
            const connector = new Connector(['first', 'second']);
            expect(await connector.getAllConfig()).to.deep.equal(configs);
            expect(axiosStub.post.callCount).to.equal(2);
            expect(connector._lastGoodIdx).to.equal(1);
        });
    });
}

module.exports = [registerResultErrorFailover, registerConfigResultErrorFailover];
