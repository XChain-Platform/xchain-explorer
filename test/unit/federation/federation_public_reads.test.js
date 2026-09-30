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
 *
 * The federation reads are public, like every other explorer route.
 *
 * getrollcallsigners, getanchoraction, getanchorconfirmations, getarchiveanchor and
 * getpricebatches answer any caller off the replica: no key is configured, none is
 * required, and a key a validator's client sends anyway (its DOGE_INDEXER_API_KEY
 * rides as x-api-key when set) changes nothing. A key gate stood in front of these
 * until 2026-09-23 and made every outside validator depend on a secret for rows the
 * explorer pages already show; these cases pin that it is gone and that ping and
 * unknown methods answer exactly as they did before the federation reads existed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { buildRpcApp, post, call } = require('./support/rpc_app.js');
const { explorerDb } = require('./support/scripted_db.js');
const { FEDERATION_READ_METHODS } = require('../../../src/federation');
const { getLogger } = require('../../../src/observability');
const { srcText }   = require('../../helpers/source_text');

const PRICE_PARAMS = { first_round: 0, last_round: 10 };
const PRICE_RESULT = { block_index: 42, first_round: 0, last_round: 10, truncated: false,
    batches: [{ action_index: 3, first_round: 1, last_round: 2, round_count: 2 }] };

// An app over a scripted DOGE testnet replica with one price batch on it.
function replicaApp() {
    const db = explorerDb({ tip: 42, prices: [{ action_index: 3, batch_first_round: 1, batch_last_round: 2, round_count: 2 }] }, []);
    return buildRpcApp({ db });
}

describe('federation reads: public', function () {
    this.timeout(10000);
    beforeEach(() => sinon.stub(getLogger(), 'info'));
    afterEach(() => sinon.restore());

    it('serves a call with no key', async () => {
        const r = await post(replicaApp(), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS));
        assert.deepStrictEqual([r.status, r.body.result], [200, PRICE_RESULT]);
    });

    it('serves the same answer whatever x-api-key a validator client sends', async () => {
        for (const headers of [{ 'x-api-key': '' }, { 'x-api-key': 'a-validators-own-indexer-key' }]) {
            const r = await post(replicaApp(), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS), headers);
            assert.deepStrictEqual([r.status, r.body.result], [200, PRICE_RESULT]);
        }
    });

    it('serves a batch mixing ping and a federation read', async () => {
        const r = await post(replicaApp(), '/TDOGE/api/', [call('ping', {}, 1), call('getpricebatches', PRICE_PARAMS, 2)]);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.map(x => [x.id, x.result]), [[1, 'pong'], [2, PRICE_RESULT]]);
    });

    it('ping needs nothing', async () => {
        const r = await post(replicaApp(), '/TDOGE/api/', call('ping'));
        assert.deepStrictEqual([r.status, r.body.result], [200, 'pong']);
    });

    it('an unknown method still answers -32601, exactly as before the federation reads', async () => {
        const before = await post(buildRpcApp({ withFederation: false }), '/TDOGE/api/', call('getnothing'));
        const after  = await post(replicaApp(), '/TDOGE/api/', call('getnothing'));
        assert.strictEqual(after.body.error.code, -32601);
        assert.deepStrictEqual([after.status, after.body], [before.status, before.body]);
    });

    it('the federation set is exactly the five reads', () => {
        assert.deepStrictEqual([...FEDERATION_READ_METHODS].sort(),
            ['getanchoraction', 'getanchorconfirmations', 'getarchiveanchor', 'getpricebatches', 'getrollcallsigners']);
    });
});

describe('federation reads: wiring in the service', function () {
    it('src/api.js puts the federation methods on the JSON-RPC controller', () => {
        const src = srcText('src/api.js');
        assert.match(src, /\.\.\.buildFederationRpc\(getExplorer, configInfo\)/);
    });

    it('nothing but the batch cap and the body default stands between the rate limiter and the router', () => {
        const src = srcText('src/http/api_boot/json_rpc.js');
        const bodyIdx   = src.indexOf('if (req.body === undefined) req.body = {}');
        const routerIdx = src.indexOf('app.use(jsonRouter(');
        assert.ok(bodyIdx > -1 && routerIdx > bodyIdx, 'body default < router');
        assert.strictEqual((src.match(/app\.use\(/g) || []).length, 3, 'batch cap, body default, router');
        assert.doesNotMatch(src, /x-api-key|FEDERATION_READ_KEY|key_gate/);
    });

    it('src/config.js no longer reads a federation read key', () => {
        const configInfo = require('../../../src/config.js');
        assert.strictEqual(configInfo.federationReadKey, undefined);
        assert.doesNotMatch(srcText('src/config.js'), /EXPLORER_FEDERATION_READ_KEY/);
    });
});
