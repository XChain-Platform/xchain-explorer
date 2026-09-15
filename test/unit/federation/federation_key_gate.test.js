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
 * The federation reads are key-gated and fail closed.
 *
 * getrollcallsigners, getanchoraction, getanchorconfirmations, getarchiveanchor and
 * getpricebatches expose validator presence and anchor state, so a public explorer
 * answers them only to a caller presenting EXPLORER_FEDERATION_READ_KEY in x-api-key.
 * A missing or wrong key, or no key configured at all, answers HTTP 401 with the
 * indexer's JSON-RPC -32001 body. ping and unknown methods answer exactly as they did
 * before the federation reads existed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { buildRpcApp, post, call } = require('./support/rpc_app.js');
const { explorerDb } = require('./support/scripted_db.js');
const { keyEquals, makeFederationKeyGate } = require('../../../src/federation/key_gate.js');
const { FEDERATION_READ_METHODS } = require('../../../src/federation');
const { getLogger } = require('../../../src/observability');
const { srcText }   = require('../../helpers/source_text');

const KEY = 'federation-test-key-0123456789';
const UNAUTHORIZED = { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } };
const PRICE_PARAMS = { first_round: 0, last_round: 10 };

// An app over a scripted DOGE testnet replica with one price batch on it.
function gatedApp(key) {
    const db = explorerDb({ tip: 42, prices: [{ action_index: 3, batch_first_round: 1, batch_last_round: 2, round_count: 2 }] }, []);
    return buildRpcApp({ key, db });
}

describe('federation reads: key gate', function () {
    this.timeout(10000);
    beforeEach(() => sinon.stub(getLogger(), 'info'));
    afterEach(() => sinon.restore());

    it('refuses a call with no key', async () => {
        const r = await post(gatedApp(KEY), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS));
        assert.strictEqual(r.status, 401);
        assert.deepStrictEqual(r.body, UNAUTHORIZED);
    });

    it('refuses a wrong key of the same length and of another length', async () => {
        const same = await post(gatedApp(KEY), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS), { 'x-api-key': KEY.replace(/.$/, 'X') });
        const other = await post(gatedApp(KEY), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS), { 'x-api-key': 'short' });
        assert.deepStrictEqual([same.status, other.status], [401, 401]);
        assert.deepStrictEqual(same.body, UNAUTHORIZED);
    });

    it('serves the right key', async () => {
        const r = await post(gatedApp(KEY), '/TDOGE/api/', call('getpricebatches', PRICE_PARAMS), { 'x-api-key': KEY });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.result, { block_index: 42, first_round: 0, last_round: 10, truncated: false,
            batches: [{ action_index: 3, first_round: 1, last_round: 2, round_count: 2 }] });
    });

    it('refuses every caller while the key is unset, whatever they send', async () => {
        for (const headers of [{}, { 'x-api-key': '' }, { 'x-api-key': KEY }]) {
            const r = await post(gatedApp(''), '/TDOGE/api/', call('getrollcallsigners', {}), headers);
            assert.strictEqual(r.status, 401);
            assert.deepStrictEqual(r.body, UNAUTHORIZED);
        }
    });

    it('refuses a batch that hides a gated call behind ping, with a null id', async () => {
        const r = await post(gatedApp(KEY), '/TDOGE/api/', [call('ping', {}, 1), call('getanchoraction', {}, 2)]);
        assert.strictEqual(r.status, 401);
        assert.deepStrictEqual(r.body, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    });

    it('gates a method name in any letter case, as the indexer does', async () => {
        const r = await post(gatedApp(KEY), '/TDOGE/api/', call('GetPriceBatches', PRICE_PARAMS));
        assert.strictEqual(r.status, 401);
    });
});

describe('federation reads: what the gate leaves alone', function () {
    this.timeout(10000);
    beforeEach(() => sinon.stub(getLogger(), 'info'));
    afterEach(() => sinon.restore());

    it('ping needs no key, configured or not', async () => {
        for (const key of [KEY, '']) {
            const r = await post(gatedApp(key), '/TDOGE/api/', call('ping'));
            assert.deepStrictEqual([r.status, r.body.result], [200, 'pong']);
        }
    });

    it('an unknown method still answers -32601, exactly as before the federation reads', async () => {
        const before = await post(buildRpcApp({ withFederation: false }), '/TDOGE/api/', call('getnothing'));
        for (const headers of [{}, { 'x-api-key': KEY }]) {
            const after = await post(gatedApp(KEY), '/TDOGE/api/', call('getnothing'), headers);
            assert.strictEqual(after.body.error.code, -32601);
            assert.deepStrictEqual([after.status, after.body], [before.status, before.body]);
        }
    });

    it('the gated set is exactly the five federation reads', () => {
        assert.deepStrictEqual([...FEDERATION_READ_METHODS].sort(),
            ['getanchoraction', 'getanchorconfirmations', 'getarchiveanchor', 'getpricebatches', 'getrollcallsigners']);
    });

    it('keyEquals admits only the exact key', () => {
        assert.strictEqual(keyEquals(KEY, KEY), true);
        assert.strictEqual(keyEquals(KEY + ' ', KEY), false);
        assert.strictEqual(keyEquals(undefined, ''), true);
        assert.strictEqual(keyEquals('', KEY), false);
    });

    it('reads the key per request, so an unset key never admits a caller', () => {
        let key = KEY;
        const gate = makeFederationKeyGate(() => key, FEDERATION_READ_METHODS);
        const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
        const next = sinon.stub();
        gate({ body: call('getpricebatches'), headers: { 'x-api-key': KEY } }, res, next);
        key = '';
        gate({ body: call('getpricebatches'), headers: { 'x-api-key': KEY } }, res, next);
        assert.strictEqual(next.callCount, 1);
        assert.ok(res.status.calledOnceWith(401));
    });
});

describe('federation reads: wiring in the service', function () {
    it('src/api.js puts the federation methods on the JSON-RPC controller', () => {
        const src = srcText('src/api.js');
        assert.match(src, /\.\.\.buildFederationRpc\(getExplorer, configInfo\)/);
    });

    it('the gate is mounted after the body default and before the router', () => {
        const src = srcText('src/http/api_boot/json_rpc.js');
        const bodyIdx   = src.indexOf('if (req.body === undefined) req.body = {}');
        const gateIdx   = src.indexOf('app.use(makeFederationKeyGate(');
        const routerIdx = src.indexOf('app.use(jsonRouter(');
        assert.ok(bodyIdx > -1 && gateIdx > bodyIdx && routerIdx > gateIdx, 'body default < gate < router');
    });

    it('src/config.js reads EXPLORER_FEDERATION_READ_KEY live, empty when unset', () => {
        const configInfo = require('../../../src/config.js');
        const saved = process.env.EXPLORER_FEDERATION_READ_KEY;
        try {
            delete process.env.EXPLORER_FEDERATION_READ_KEY;
            assert.strictEqual(configInfo.federationReadKey(), '');
            process.env.EXPLORER_FEDERATION_READ_KEY = KEY;
            assert.strictEqual(configInfo.federationReadKey(), KEY);
        } finally {
            if (saved === undefined) delete process.env.EXPLORER_FEDERATION_READ_KEY;
            else process.env.EXPLORER_FEDERATION_READ_KEY = saved;
        }
    });
});
