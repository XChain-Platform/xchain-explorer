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
 * Strategy: proxyquire replaces express and db/index.js so the class can be instantiated
 * without a real database or HTTP server.  A MockDB captures the cfg object passed
 * to getData(), letting each test inspect what processRequest() built from the URL.
 */

const { expect, mockReq, mockRes, makeExplorer, request, state } = require('./helpers.js');

let explorer;
before(function () { explorer = state.explorer; });

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

function registerSendsMethodMatchTest() {
    it('/BTC/api/sends/addr1/address → method=getSends, search=addr1, type=address', async function () {
        const { cfg } = await request(explorer, '/BTC/api/sends/addr1/address');
        expect(cfg).to.not.be.null;
        expect(cfg.data.method).to.equal('getSends');
        expect(cfg.data.search).to.equal('addr1');
        expect(cfg.data.type).to.equal('address');
    });
}

describe('method matching (api)', function () {

    registerSendsMethodMatchTest();
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

describe('percent-encoded path segments', function () {
    // req.path arrives still encoded. TDOGE issued "$$$$$$$$$$$78324%@##*(@#",
    // which a client can only send encoded, and a lookup on the encoded form
    // answered NOT_FOUND for a token that exists.
    it('decodes the tick segment before it becomes the search key', async function () {
        const { cfg } = await request(explorer, '/BTC/api/token/%24%24%24%24%24%24%24%24%24%24%2478324%25%40%23%23*(%40%23');
        expect(cfg).to.not.be.null;
        expect(cfg.data.method).to.equal('getToken');
        expect(cfg.data.search).to.equal('$$$$$$$$$$$78324%@##*(@#');
    });

    it('keeps an encoded slash inside its segment rather than splitting it', async function () {
        const { cfg } = await request(explorer, '/BTC/api/token/A%2FB');
        expect(cfg).to.not.be.null;
        expect(cfg.data.method).to.equal('getToken');
        expect(cfg.data.search).to.equal('A/B');
    });

    it('decodes both ticks of a market pair', async function () {
        const { cfg } = await request(explorer, '/BTC/api/market/A%23B/C%25D');
        expect(cfg).to.not.be.null;
        expect(cfg.data.method).to.equal('getMarket');
        expect(cfg.data.search).to.equal('A#B');
        expect(cfg.data.search2).to.equal('C%D');
    });

    it('leaves a segment whose encoding does not parse as it came', async function () {
        const { cfg } = await request(explorer, '/BTC/api/token/BAD%ZZ');
        expect(cfg).to.not.be.null;
        expect(cfg.data.search).to.equal('BAD%ZZ');
    });
});
