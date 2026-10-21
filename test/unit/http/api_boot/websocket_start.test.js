/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The live-feed boot step starts the poller even with no pools yet
 *
 * A boot with the config hub unreachable has an empty pool map. The poller
 * must still start, so it can adopt each coin whose pool the hub sync or the
 * lazy rebuild adds later; a poller never started is a feed dead for good.
 *
 * Run: mocha test/unit/http/api_boot/websocket_start.test.js --timeout 0
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');

const WebSocketServer     = require('../../../../src/ws/websocket_server.js');
const ChangeDetector      = require('../../../../src/ws/change_detector.js');
const { startWebsockets } = require('../../../../src/http/api_boot/websocket.js');

// The boot deps with the given pool map and env; the listeners are never attached.
function bootDeps(pools, env) {
    return {
        configInfo:  { env: env || {} },
        explorer:    { db: { pools } },
        httpServer:  {},
        httpsServer: null,
        runtime:     {}
    };
}

describe('startWebsockets live-feed start', function () {
    let start;

    beforeEach(function () {
        sinon.stub(WebSocketServer.prototype, 'attach');
        start = sinon.stub(ChangeDetector.prototype, 'start');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('starts the poller with no coins when the boot has no pools', function () {
        const deps = bootDeps({});
        startWebsockets(deps);
        expect(start.calledOnce).to.equal(true);
        expect(start.firstCall.args[0]).to.deep.equal([]);
        expect(deps.runtime.changeDetector).to.be.an.instanceof(ChangeDetector);
    });

    it('starts the poller with every pooled coin when pools exist', function () {
        startWebsockets(bootDeps({ BTC: { pool: {} }, TLTC: { pool: {} } }));
        expect(start.calledOnce).to.equal(true);
        expect(start.firstCall.args[0]).to.deep.equal(['BTC', 'TLTC']);
    });
});

// The hop count keys the per-IP cap. 0 means no proxy in front, so the cap must key
// on the TCP peer and never on a client-written X-Forwarded-For token.
describe('startWebsockets trusted proxy hops', function () {
    beforeEach(function () {
        sinon.stub(WebSocketServer.prototype, 'attach');
        sinon.stub(ChangeDetector.prototype, 'start');
    });

    afterEach(function () {
        sinon.restore();
    });

    function hopsFor(env) {
        const deps = bootDeps({}, env);
        startWebsockets(deps);
        return deps.runtime.wsServer.trustProxyHops;
    }

    it('keeps WS_TRUST_PROXY_HOPS=0 so the cap keys on the TCP peer', function () {
        expect(hopsFor({ WS_TRUST_PROXY_HOPS: '0' })).to.equal(0);
        const server = new WebSocketServer({ trustProxyHops: hopsFor({ WS_TRUST_PROXY_HOPS: '0' }) });
        const req = { headers: { 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '10.0.0.9' } };
        expect(server.clientIp(req)).to.equal('10.0.0.9');
    });

    it('defaults to one hop only when the value is missing or invalid', function () {
        expect(hopsFor({})).to.equal(1);
        expect(hopsFor({ WS_TRUST_PROXY_HOPS: 'many' })).to.equal(1);
        expect(hopsFor({ WS_TRUST_PROXY_HOPS: '-1' })).to.equal(1);
        expect(hopsFor({ WS_TRUST_PROXY_HOPS: '2' })).to.equal(2);
    });
});
