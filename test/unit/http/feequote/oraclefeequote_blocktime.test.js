/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');

function fakeThis() {
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'BTC', network: 'regtest' }),
        util: { isNull: (v) => v === undefined || v === null || v === '' }
    };
}

function response() {
    return {
        _status: 200, _body: null,
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; }
    };
}

async function request(blockTime) {
    const query = { oracleAddress: 'addr', giveTick: 'XCH', fiatCode: 'USD' };
    if(blockTime !== undefined) query.blockTime = blockTime;
    const res = response();
    await XChainExplorer.prototype.processOracleFeeQuoteRequest.call(fakeThis(),
        { params: { coin: 'RBTC' }, query }, res);
    return res;
}

describe('oraclefeequote blockTime validation', function () {
    beforeEach(function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('configured');
        IndexerConnector.resetEgressBudgets();
    });
    afterEach(function () { sinon.restore(); });

    it('rejects non-canonical or unsafe values before calling the indexer', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        for(const value of ['0', '007', '00', '-1', '1.5', 'abc', '99999999999999999999']) {
            const res = await request(value);
            expect(res._status, value).to.equal(400);
            expect(res._body, value).to.deep.equal({ error: 'invalid blockTime', code: 'INVALID_PARAMETER' });
        }
        expect(call.called).to.equal(false);
    });

    it('forwards canonical positive safe integers unchanged', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        for(const value of ['1', '1700000000']) {
            const res = await request(value);
            expect(res._status).to.equal(200);
            expect(res._body).to.deep.equal({ ok: true });
        }
        expect(call.firstCall.args[0].blockTime).to.equal('1');
        expect(call.secondCall.args[0].blockTime).to.equal('1700000000');
    });

    it('continues to allow an omitted blockTime', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        const res = await request(undefined);
        expect(res._status).to.equal(200);
        expect(call.calledOnce).to.equal(true);
        expect(call.firstCall.args[0].blockTime).to.equal(undefined);
    });
});
