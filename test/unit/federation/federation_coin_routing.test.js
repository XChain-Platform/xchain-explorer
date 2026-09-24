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
 * A federation read answers off the replica its request path names.
 *
 * The dispatcher is root-mounted, so /TDOGE/api/ and /TBTC/api/ reach the same
 * method map and only the path says which coin's replica to read. These cases pin
 * that routing: the DOGE-only roll-call read refuses a BTC path with the indexer's
 * own error, every statement goes to the routed coin's pool, a path naming no coin
 * or a coin with no replica refuses, a replica halted on divergence refuses with
 * the indexer's "not ready", and each read writes one log line.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { buildRpcApp, post, call } = require('./support/rpc_app.js');
const { explorerDb } = require('./support/scripted_db.js');
const { rollcallManifestHash, ROLLCALL_ACTIVATION,
        ROLLCALL_GATES_ACTIVATION } = require('../../../src/federation/rollcall_signers.js');
const { resolveRouteCoin, readVerdict, answeredTip } = require('../../../src/federation');
const { getLogger } = require('../../../src/observability');

const KEY = 'routing-test-key';
const AUTH = { 'x-api-key': KEY };
const PUBKEY = 'd'.repeat(64);
const ROLLCALL = { network: 'testnet', epoch_height: 5, max_block_time: 2000, pubkeys: [PUBKEY], publishers: [] };
const SCENARIO = { tip: 90, tipTime: 3000, hcut: 60,
    signers: [{ pubkey: PUBKEY, sig: 'ee'.repeat(32), ledger_hash: 'ff'.repeat(32), publisher: PUBKEY, action_index: 4, block_index: 55, gates: null }],
    prices: [] };

// A keyed app over one scripted replica, plus the calls it recorded.
function routedApp(dbOpts) {
    const calls = [];
    const app = buildRpcApp({ key: KEY, db: explorerDb(SCENARIO, calls, dbOpts) });
    return { app, calls };
}

describe('federation reads: coin routing', function () {
    this.timeout(10000);
    beforeEach(() => sinon.stub(getLogger(), 'info'));
    afterEach(() => sinon.restore());

    it('serves getrollcallsigners off the TDOGE replica, with or without the trailing slash', async () => {
        for (const path of ['/TDOGE/api/', '/TDOGE/api', '/tdoge/api/']) {
            const { app, calls } = routedApp();
            const r = await post(app, path, call('getrollcallsigners', ROLLCALL), AUTH);
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body.result, { hcut: 60, tip_block_index: 90, tip_block_time: 3000,
                manifest_hash: rollcallManifestHash(),
                rollcall_activation: ROLLCALL_ACTIVATION['testnet'],
                rollcall_gates_activation: ROLLCALL_GATES_ACTIVATION['testnet'],
                signers: { [PUBKEY]: { sig: 'ee'.repeat(32), ledger_hash: 'ff'.repeat(32), publisher: PUBKEY,
                                       action_index: 4, block_index: 55, gates: null } },
                publishers: {} });
            assert.ok(calls.length > 0 && calls.every(c => c.coin === 'TDOGE'), 'every statement went to the TDOGE pool');
        }
    });

    it('refuses getrollcallsigners on TBTC with the indexer\'s DOGE-only error, reading nothing', async () => {
        const { app, calls } = routedApp();
        const r = await post(app, '/TBTC/api/', call('getrollcallsigners', ROLLCALL), AUTH);
        assert.deepStrictEqual(r.body.result, { error: 'getrollcallsigners is DOGE-only' });
        assert.deepStrictEqual(calls, []);
    });

    it('serves a coin-neutral read off the TBTC replica', async () => {
        const { app, calls } = routedApp();
        const r = await post(app, '/TBTC/api/', call('getpricebatches', { first_round: 1, last_round: 2 }), AUTH);
        assert.strictEqual(r.body.result.block_index, 90);
        assert.ok(calls.every(c => c.coin === 'TBTC'));
    });
});

describe('federation reads: refusals and the log line', function () {
    this.timeout(10000);
    let info;
    beforeEach(() => { info = sinon.stub(getLogger(), 'info'); });
    afterEach(() => sinon.restore());

    it('checks the network against the routed coin, not a fixed one', async () => {
        const { app } = routedApp();
        const regtest = Object.assign({}, ROLLCALL, { network: 'regtest' });
        const onTestnet = await post(app, '/TDOGE/api/', call('getrollcallsigners', regtest), AUTH);
        const onRegtest = await post(app, '/RDOGE/api/', call('getrollcallsigners', regtest), AUTH);
        assert.deepStrictEqual(onTestnet.body.result, { error: 'network mismatch' });
        assert.strictEqual(onRegtest.body.result.hcut, 60);
    });

    it('refuses a path that names no coin', async () => {
        for (const path of ['/', '/XYZ/api/', '/TDOGE/api/extra', '/TDOGE/']) {
            const { app, calls } = routedApp();
            const r = await post(app, path, call('getpricebatches', { first_round: 1, last_round: 2 }), AUTH);
            assert.deepStrictEqual(r.body.result, { error: 'unknown coin' }, path);
            assert.strictEqual(calls.length, 0);
        }
    });

    it('answers "not ready" for a coin this explorer holds no replica of', async () => {
        const { app } = routedApp({ pools: { TDOGE: { pool: {} } } });
        const r = await post(app, '/TLTC/api/', call('getpricebatches', { first_round: 1, last_round: 2 }), AUTH);
        assert.deepStrictEqual(r.body.result, { error: 'indexer database not ready' });
    });

    it('answers "not ready" off a halted replica without running the read', async () => {
        const { app, calls } = routedApp({ halted: true });
        const r = await post(app, '/TDOGE/api/', call('getrollcallsigners', ROLLCALL), AUTH);
        assert.deepStrictEqual(r.body.result, { error: 'indexer database not ready' });
        assert.strictEqual(calls.length, 0);
    });

    it('writes one log line per read with coin, method, verdict, tip and duration', async () => {
        const { app } = routedApp();
        await post(app, '/TDOGE/api/', call('getrollcallsigners', ROLLCALL), AUTH);
        const lines = info.getCalls().filter(c => c.args[0] === 'FEDERATION_READ');
        assert.strictEqual(lines.length, 1);
        const f = lines[0].args[1];
        assert.deepStrictEqual([f.coin, f.method, f.verdict, f.tip, f.halted], ['TDOGE', 'getrollcallsigners', 'decided', 90, false]);
        assert.ok(Number.isInteger(f.ms) && f.ms >= 0);
    });
});

describe('federation reads: routing and log helpers', function () {
    const configInfo = { getConfig: async () => ({ COIN_NETWORKS: { BTC: 1, DOGE: 1 }, COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' } }) };

    it('splits a path code into pool key, base coin and network', async () => {
        assert.deepStrictEqual(await resolveRouteCoin(configInfo, { path: '/DOGE/api/' }), { code: 'DOGE', coin: 'DOGE', network: 'mainnet' });
        assert.deepStrictEqual(await resolveRouteCoin(configInfo, { path: '/RBTC/api' }), { code: 'RBTC', coin: 'BTC', network: 'regtest' });
        assert.strictEqual(await resolveRouteCoin(configInfo, { path: '/TLTC/api/' }), null);
        assert.strictEqual(await resolveRouteCoin({ getConfig: async () => { throw new Error('down'); } }, { path: '/DOGE/api/' }), null);
    });

    it('reads a refusal or an uncut roll-call window as undecided', () => {
        assert.strictEqual(readVerdict('getpricebatches', { error: 'x' }), 'undecided');
        assert.strictEqual(readVerdict('getrollcallsigners', { hcut: null, signers: {} }), 'undecided');
        assert.strictEqual(readVerdict('getanchoraction', { exists: false, latest_block_index: 3 }), 'decided');
        assert.deepStrictEqual([answeredTip({ tip_block_index: 1 }), answeredTip({ latest_block_index: 2 }),
            answeredTip({ block_index: 3 }), answeredTip({ error: 'x' })], [1, 2, 3, null]);
    });
});
