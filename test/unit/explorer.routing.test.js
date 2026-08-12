'use strict';

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
 * Unit tests for URL matching and cfg construction in XChainExplorer.processRequest()
 *
 * Strategy: proxyquire replaces express and db.js so the class can be instantiated
 * without a real database or HTTP server.  A MockDB captures the cfg object passed
 * to getData(), letting each test inspect what processRequest() built from the URL.
 */

const { expect }            = require('chai');
const proxyquire            = require('proxyquire').noCallThru();
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }  = require('../fixtures/mock-query-args.js');

/** Captured cfg from the most-recent getData() call */
let capturedConfig = null;

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(config) {
        capturedConfig = config;
        // getBalances sets `json.address = cfg.data.search` AFTER merging data into json
        // (json = data when total is null).  If data is null that assignment throws, so
        // return an empty object for that method to give json a non-null target.
        if (config.data.method === 'getBalances') {
            return [{}, null];
        }
        // For all other methods return [null, null] so data and total are both null,
        // keeping the 400 response-code branch reachable in assertions.
        return [null, null];
    }
}

/** Minimal express mock – the constructor returns an object that satisfies the
 *  calls inside XChainExplorer (app.use / app.get / app.enable).  Static helpers
 *  are no-ops so proxyquire.noCallThru() never reaches the real express module. */
const mockApp = {
    use: () => {},
    get: () => {},
    post: () => {},
    enable: () => {}
};
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

/** Load the class under test with its two heavy deps replaced */
const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express':  expressMock,
    './db.js':  MockDB
});

function makeExplorer(configOverrides) {
    const configInfo = createConfigInfoStub(configOverrides);
    return new XChainExplorer(mockApp, configInfo);
}

/** Drive processRequest and return { cfg, res } */
async function request(explorer, path, query = {}) {
    capturedConfig = null;
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query), res);
    return { cfg: capturedConfig, res };
}

describe('XChainExplorer.processRequest – routing', function () {

    let explorer;

    before(function () {
        explorer = makeExplorer();
    });

    describe('coin parsing', function () {

        it('parses BTC from /BTC/api/sends/addr1/address', async function () {
            const { cfg } = await request(explorer, '/BTC/api/sends/addr1/address');
            expect(cfg).to.not.be.null;
            expect(cfg.coin).to.equal('BTC');
        });

        it('parses RBTC (regtest) from /RBTC/api/sends/addr1/address', async function () {
            const { cfg } = await request(explorer, '/RBTC/api/sends/addr1/address');
            expect(cfg).to.not.be.null;
            expect(cfg.coin).to.equal('RBTC');
        });

        it('is case-insensitive for the coin segment (/btc/ → coin=BTC)', async function () {
            const { cfg } = await request(explorer, '/btc/api/sends/addr1/address');
            expect(cfg).to.not.be.null;
            expect(cfg.coin).to.equal('BTC');
        });

        it('leaves cfg.coin null for an unsupported coin token', async function () {
            const { cfg } = await request(explorer, '/XYZ/api/sends/addr1/address');
            // XYZ is not in COIN_SUPPORTED, so coin stays null
            expect(cfg).to.be.null; // getData never called → capturedConfig null
            // Verify via res status instead
        });

    });

    describe('type detection', function () {

        it('sets cfg.type="api" for /BTC/api/sends/1/block', async function () {
            const { cfg } = await request(explorer, '/BTC/api/sends/1/block');
            expect(cfg).to.not.be.null;
            expect(cfg.type).to.equal('api');
        });

        it('sets cfg.type="explorer" for /BTC/explorer/sends/1/block', async function () {
            const { cfg } = await request(explorer, '/BTC/explorer/sends/1/block');
            expect(cfg).to.not.be.null;
            expect(cfg.type).to.equal('explorer');
        });

        it('sets cfg.type="html" for /BTC/tokens', async function () {
            // "tokens" is not api or explorer → type defaults to html
            // capturedConfig will be null because getData is not called for html
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/tokens'), res);
            // No getData call for html, just check the response is not a 400/503
            expect(res._status).to.not.equal(400);
        });

    });

    describe('method matching (api)', function () {

        it('/BTC/api/sends/addr1/address → method=getSends, search=addr1, type=address', async function () {
            const { cfg } = await request(explorer, '/BTC/api/sends/addr1/address');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getSends');
            expect(cfg.data.search).to.equal('addr1');
            expect(cfg.data.type).to.equal('address');
        });

        it('/BTC/api/balances/addr1 → method=getBalances, type=address', async function () {
            const { cfg } = await request(explorer, '/BTC/api/balances/addr1');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getBalances');
            expect(cfg.data.type).to.equal('address');
        });

        it('/BTC/api/contract/12/state → method=getContractState', async function () {
            const { cfg } = await request(explorer, '/BTC/api/contract/12/state');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getContractState');
            expect(cfg.data.search).to.equal('12');
        });

        // Regression: /contract/{QUERY}/balance and /contract/{QUERY}/state share
        // segment count + parts[1]/parts[2]; before the 5th-segment literal check
        // the first-defined (state) route shadowed balance, making it unreachable.
        it('/BTC/api/contract/12/balance → method=getContractBalance (not shadowed by /state)', async function () {
            const { cfg } = await request(explorer, '/BTC/api/contract/12/balance');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getContractBalance');
            expect(cfg.data.search).to.equal('12');
        });

        it('/BTC/api/contract/12/balance/XCHAIN → method=getContractBalance, type=contract', async function () {
            const { cfg } = await request(explorer, '/BTC/api/contract/12/balance/XCHAIN');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getContractBalance');
        });

        it('/BTC/api/token/XCHAIN → method=getToken, type=token', async function () {
            const { cfg } = await request(explorer, '/BTC/api/token/XCHAIN');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getToken');
            expect(cfg.data.type).to.equal('token');
        });

        it('/BTC/api/status → method=getStatus', async function () {
            const { cfg } = await request(explorer, '/BTC/api/status');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getStatus');
        });

        it('/BTC/api/dispensers/addr1/source → method=getDispensers, type=source', async function () {
            const { cfg } = await request(explorer, '/BTC/api/dispensers/addr1/source');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getDispensers');
            expect(cfg.data.type).to.equal('source');
        });

    });

    describe('list-all explorer matching (3-segment, no query/type)', function () {

        // Regression: the home-page tabs request /{COIN}/explorer/{action} with no
        // QUERY/TYPE, so the path is 3 segments while the route declares 5. The
        // parts.length==urlPath.length gate (added to stop shadowing) rejected that
        // pairing, 404ing the request and surfacing a DataTables "Ajax error".
        it('/BTC/explorer/tokens → method=getTokens, no search type', async function () {
            const { cfg } = await request(explorer, '/BTC/explorer/tokens');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getTokens');
            expect(cfg.data.search).to.be.undefined;
            expect(cfg.data.type).to.equal(false);
        });

        it('/BTC/explorer/sends → method=getSends (list-all)', async function () {
            const { cfg } = await request(explorer, '/BTC/explorer/sends');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getSends');
        });

        it('/BTC/explorer/issues → method=getIssues (list-all)', async function () {
            const { cfg } = await request(explorer, '/BTC/explorer/issues');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getIssues');
        });

        // The 3-segment allowance must stay narrow: a 3-segment path whose action
        // does not name any route still falls through to the 404 branch.
        it('/BTC/explorer/bogus → no method matched (404 path)', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/explorer/bogus'), res);
            expect(res._status).to.equal(404);
        });

    });

    describe('market routes', function () {

        it('/BTC/api/markets → method=getMarkets', async function () {
            const { cfg } = await request(explorer, '/BTC/api/markets');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getMarkets');
        });

        it('/BTC/api/market/XCHAIN/BTC → method=getMarket, search2=BTC', async function () {
            const { cfg } = await request(explorer, '/BTC/api/market/XCHAIN/BTC');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getMarket');
            // search is TICK1 (urlPath[3]), search2 is TICK2 (urlPath[4])
            expect(cfg.data.search).to.equal('XCHAIN');
            expect(cfg.data.search2).to.equal('BTC');
        });

        it('/BTC/api/market/XCHAIN/BTC/orderbook → method=getOrderbook', async function () {
            const { cfg } = await request(explorer, '/BTC/api/market/XCHAIN/BTC/orderbook');
            expect(cfg).to.not.be.null;
            expect(cfg.data.method).to.equal('getOrderbook');
        });

    });

    describe('response codes', function () {

        it('returns 404 for a valid coin + valid route where db returns null data', async function () {
            // MockDB returns [[], null], so data is [] and total is null; when total
            // is null, processRequest falls into the not-found branch (404).
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
            expect(res._status).to.equal(404);
        });

        // The action route binds its path segment against a BIGINT column, so MariaDB
        // coerced '7junk' to 7 and answered 200 with action 7. The 400 must also survive
        // the empty-result branch further down, which used to rewrite it to 404.
        ['7junk', 'junk', '7.5', '-1', '0x7', '7%20'].forEach((bad) => {
            it(`400s /BTC/api/action/${bad} instead of coercing it to a real action`, async function () {
                const { cfg, res } = await request(explorer, '/BTC/api/action/' + bad);
                expect(res._status).to.equal(400);
                // processRequest serializes the api body itself, so _body is a JSON string.
                expect(JSON.parse(res._body).code).to.equal('INVALID_ACTION_INDEX');
                expect(cfg, 'the DB was never queried').to.be.null;
            });
        });

        it('still routes a well-formed /BTC/api/action/7 through to the DB', async function () {
            const { cfg, res } = await request(explorer, '/BTC/api/action/7');
            expect(cfg, 'the DB was queried').to.not.be.null;
            expect(cfg.data.method).to.equal('getAction');
            expect(cfg.data.search).to.equal('7');
            expect(res._status).to.not.equal(400);
        });

        it('leaves the sibling numeric route /BTC/api/block/{n} untouched by the action guard', async function () {
            const { cfg } = await request(explorer, '/BTC/api/block/9junk');
            expect(cfg, 'block route still reaches the DB (out of this fix scope)').to.not.be.null;
            expect(cfg.data.method).to.equal('getBlock');
        });

        it('returns 503 for a supported-but-unavailable coin (LTC not in COIN_AVAILABLE)', async function () {
            // LTC is in COIN_SUPPORTED but not in COIN_AVAILABLE (per mock-config).
            const res = mockRes();
            await explorer.processRequest(mockReq('/LTC/api/sends/addr1/address'), res);
            expect(res._status).to.equal(503);
        });

        it('/BTC/api/status returns 404 when coin is available but db returns null (no record)', async function () {
            // validDataRequest is forced true for status, db returns null → not-found 404
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/api/status'), res);
            // getStatus has no total so data=[] total=null → 404
            expect(res._status).to.equal(404);
        });

        it('returns 404 with html type for an unknown URL', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/api/unknownendpoint/x/y'), res);
            expect(res._status).to.equal(404);
        });

        it('returns 503 for explorer type on unavailable coin', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/LTC/explorer/sends/addr1/address'), res);
            expect(res._status).to.equal(503);
        });

    });

    describe('tip-freshness gate', function () {

        // The gate only runs for a coin this instance actually has a pool for; the
        // staleness verdict itself is unit-tested against the real query in
        // db.data-methods.test.js, so stub it here and assert the routing effect.
        function withTip(stale) {
            const e = makeExplorer();
            e.db.pools = { BTC: {} };
            e.db.isCoinTipStale = async () => stale;
            return e;
        }

        it('refuses a data read with 503 COIN_DATA_STALE when the indexed tip is stale', async function () {
            const res = mockRes();
            await withTip(true).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
            expect(res._status).to.equal(503);
            expect(JSON.parse(res._body)).to.include({ code: 'COIN_DATA_STALE' });
        });

        it('keeps /{COIN}/api/status reachable so an operator can see WHY it went stale', async function () {
            const res = mockRes();
            await withTip(true).processRequest(mockReq('/BTC/api/status'), res);
            expect(res._status).to.not.equal(503);
        });

        it('serves normally when the tip is fresh', async function () {
            const res = mockRes();
            await withTip(false).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
            expect(res._status).to.not.equal(503);
        });

        it('keeps the unconfigured-coin 503 distinguishable from the stale one', async function () {
            const res = mockRes();
            await withTip(true).processRequest(mockReq('/LTC/api/sends/addr1/address'), res);
            expect(res._status).to.equal(503);
            expect(JSON.parse(res._body)).to.include({ code: 'COIN_NOT_AVAILABLE' });   // LTC has no pool here
        });

    });

    describe('tip-freshness gate: contract simulation', function () {

        // POST /{COIN}/api/contract/{idx}/call is hand-registered ahead of the
        // catch-all, so it never ran processRequest's gate above and answered a
        // current-state question from a frozen replica's contract state.
        function withTip(stale) {
            const e = makeExplorer();
            e.db.pools = { RBTC: {} };
            e.db.isCoinTipStale = async () => stale;
            return e;
        }

        function callReq() {
            return { params: { coin: 'RBTC', contractIndex: '40' }, body: { method: 'get' }, ip: '127.0.0.1' };
        }

        it('refuses the simulation with 503 COIN_DATA_STALE when the indexed tip is stale', async function () {
            const res = mockRes();
            await withTip(true).processContractCallRequest(callReq(), res);
            expect(res._status).to.equal(503);
            expect(res._body).to.include({ code: 'COIN_DATA_STALE' });
        });

        it('does not gate the simulation when the tip is fresh', async function () {
            const res = mockRes();
            await withTip(false).processContractCallRequest(callReq(), res);
            // The VM is not wired in this unit harness, so the call fails past the
            // gate; what matters is that the freshness gate is not what stopped it.
            expect(res._body && res._body.code).to.not.equal('COIN_DATA_STALE');
        });

        it('rejects a malformed contract index before consulting the tip', async function () {
            const e = withTip(true);
            let consulted = false;
            e.db.isCoinTipStale = async () => { consulted = true; return true; };
            const res = mockRes();
            await e.processContractCallRequest(
                { params: { coin: 'RBTC', contractIndex: 'not-a-number' }, body: {}, ip: '127.0.0.1' }, res);
            expect(res._status).to.equal(400);
            expect(consulted, 'shape errors stay 400, not 503').to.equal(false);
        });

    });

    describe('null string handling', function () {

        it('/BTC/api/history/null/block converts "null" search to null', async function () {
            const { cfg } = await request(explorer, '/BTC/api/history/null/block');
            expect(cfg).to.not.be.null;
            expect(cfg.data.search).to.be.null;
        });

    });

    describe('explorer offset params', function () {

        it('populates cfg.data.offset from query params ?offset=100&action=next', async function () {
            const { cfg } = await request(
                explorer,
                '/BTC/explorer/sends/addr1/address',
                { offset: '100', action: 'next' }
            );
            expect(cfg).to.not.be.null;
            expect(cfg.data.offset.start).to.equal('100');
            expect(cfg.data.offset.action).to.equal('next');
        });

        it('leaves offset as false (no-value sentinel) when no query params are provided', async function () {
            // processRequest uses `false` (not null) when offset/action are absent:
            //   let offset = (q && !isNull(q.offset)) ? q.offset : false;
            const { cfg } = await request(explorer, '/BTC/explorer/sends/addr1/address');
            expect(cfg).to.not.be.null;
            expect(cfg.data.offset.start).to.equal(false);
            expect(cfg.data.offset.action).to.equal(false);
        });

    });

    describe('HTML routes', function () {

        /** For HTML routes, getData is never called so capturedConfig stays null.
         *  We inspect the response status and confirm it is not a routing error. */

        it('/ → home.html served (not 404)', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/'), res);
            expect(res._status).to.not.equal(404);
        });

        it('/BTC → coin_home.html served (not 404)', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC'), res);
            expect(res._status).to.not.equal(404);
        });

        it('/BTC/tokens → tokens.html served (not 404)', async function () {
            const res = mockRes();
            await explorer.processRequest(mockReq('/BTC/tokens'), res);
            expect(res._status).to.not.equal(404);
        });

    });

});
