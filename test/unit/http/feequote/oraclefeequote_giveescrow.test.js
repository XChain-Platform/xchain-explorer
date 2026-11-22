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

async function request(giveEscrow) {
    const query = { oracleAddress: 'addr', giveTick: 'XCH', fiatCode: 'USD' };
    if(giveEscrow !== undefined) query.giveEscrow = giveEscrow;
    const res = response();
    await XChainExplorer.prototype.processOracleFeeQuoteRequest.call(fakeThis(),
        { params: { coin: 'RBTC' }, query }, res);
    return res;
}

describe('oraclefeequote giveEscrow validation', function () {
    beforeEach(function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('configured');
        IndexerConnector.resetEgressBudgets();
    });
    afterEach(function () { sinon.restore(); });

    it('forwards every decimal shape accepted by the indexer unchanged', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        const values = ['5.', '007', '05.5', '0', '1.' + '0'.repeat(19), '1'.repeat(80)];
        for(const value of values) {
            const res = await request(value);
            expect(res._status, value).to.equal(200);
            expect(res._body, value).to.deep.equal({ ok: true });
            expect(call.lastCall.args[0].giveEscrow).to.equal(value);
        }
        expect(call.callCount).to.equal(values.length);
    });

    it('rejects malformed or oversized values before calling the indexer', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        const refused = { error: 'invalid giveEscrow', code: 'INVALID_PARAMETER' };
        for(const value of ['-1', '1e3', '0x10', '.5', '.', '1.2.3', ' 5', '1'.repeat(81)]) {
            const res = await request(value);
            expect(res._status, value).to.equal(400);
            expect(res._body, value).to.deep.equal(refused);
        }
        expect(call.called).to.equal(false);
    });

    it('continues to forward an omitted giveEscrow', async function () {
        const call = sinon.stub(IndexerConnector.prototype, 'oraclefeequote').resolves({ ok: true });
        const res = await request(undefined);
        expect(res._status).to.equal(200);
        expect(call.calledOnce).to.equal(true);
        expect(call.firstCall.args[0].giveEscrow).to.equal(undefined);
    });
});
