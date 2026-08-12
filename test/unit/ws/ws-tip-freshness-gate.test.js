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
 * The frozen-replica freshness gate the HTTP path has long enforced (503
 * COIN_DATA_STALE) was absent from every WebSocket serving boundary, so a
 * replica whose tip had aged past EXPLORER_TIP_MAX_AGE_S kept answering
 * WELCOME / CATCH_UP / SNAPSHOT out of frozen tables, stamped with a
 * current `timestamp` and carrying no marker.
 *
 * The contract these tests pin:
 *   - WELCOME is the handshake, so it is ANNOTATED (`data.stale: true`), never
 *     withheld, and the marker is absent (not false) when the tip is fresh.
 *   - CATCH_UP and SNAPSHOT are chain DATA, so they FAIL CLOSED through the
 *     existing `error` frame with code COIN_DATA_STALE.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const WebSocketServer = require('../../../src/ws/WebSocketServer.js');
const ChangeDetector  = require('../../../src/ws/ChangeDetector.js');

// Collect every frame the server writes to this client.
function makeClient(coin) {
    const frames = [];
    return {
        client: {
            id: 1, coin: coin || 'BTC', chain: 'BTC', network: 'mainnet',
            ws: { readyState: 1, send: (raw) => frames.push(JSON.parse(raw)) },
            subscriptions: new Set(),
            snapshotInProgress: false,
            catchUpInProgress: false
        },
        frames
    };
}

// db double carrying the reads each serving boundary makes, plus the gate.
function makeServer(stale, dbExtra) {
    const db = {
        isCoinTipStale: async () => stale,
        getMaxBlockIndex:    async () => 100,
        getMaxActionIndex:   async () => 200n,
        getActionsSince:     async () => [],
        getAddressBalances:  async () => [{ tick: 'XCHAIN', quantity: '5' }],
        getTokenInfo:        async () => ({ tick: 'XCHAIN' }),
        getMarketInfo:       async () => ({}),
        getDispenserInfo:    async () => ({}),
        ...(dbExtra || {})
    };
    return new WebSocketServer({ explorer: { db, version: '1.0.0' }, broadcaster: null });
}

const typesOf = (frames, t) => frames.filter((f) => f.type === t);

describe('WS frozen-replica freshness gate', function () {

    describe('WELCOME', function () {

        it('marks the handshake stale rather than withholding it', async function () {
            const s = makeServer(true);
            const { client, frames } = makeClient('BTC');
            await s._sendWelcome(client);
            const welcome = typesOf(frames, 'WELCOME')[0];
            expect(welcome, 'the handshake still arrives').to.not.be.undefined;
            expect(welcome.data.stale).to.equal(true);
        });

        it('omits the marker entirely when the tip is fresh', async function () {
            const s = makeServer(false);
            const { client, frames } = makeClient('BTC');
            await s._sendWelcome(client);
            const welcome = typesOf(frames, 'WELCOME')[0];
            expect(welcome.data).to.not.have.property('stale');
            expect(welcome.data.latest_block_index).to.equal('100');
        });
    });

    describe('SNAPSHOT', function () {

        const subs = [{ channel: 'address', address: 'addr1' }, { channel: 'blocks' }];

        it('withholds every snapshot and says why when the tip is stale', async function () {
            const s = makeServer(true);
            const { client, frames } = makeClient('BTC');
            await s._sendSnapshots(client, subs);
            expect(typesOf(frames, 'SNAPSHOT'), 'no stale balance goes out as live').to.have.lengthOf(0);
            const errs = typesOf(frames, 'error');
            expect(errs).to.have.lengthOf(1);
            expect(errs[0].data.code).to.equal('COIN_DATA_STALE');
        });

        it('still serves every snapshot when the tip is fresh', async function () {
            const s = makeServer(false);
            const { client, frames } = makeClient('BTC');
            await s._sendSnapshots(client, subs);
            expect(typesOf(frames, 'SNAPSHOT')).to.have.lengthOf(2);
            expect(typesOf(frames, 'error')).to.have.lengthOf(0);
        });
    });

    describe('CATCH_UP', function () {

        it('refuses the replay with COIN_DATA_STALE when the tip is stale', async function () {
            const s = makeServer(true);
            const { client, frames } = makeClient('BTC');
            await s._handleCatchUp(client, '0', {}, 'req-1');
            expect(typesOf(frames, 'CATCH_UP_COMPLETE'),
                'a short replay must not be reported as caught-up').to.have.lengthOf(0);
            const errs = typesOf(frames, 'error');
            expect(errs).to.have.lengthOf(1);
            expect(errs[0].data.code).to.equal('COIN_DATA_STALE');
            expect(errs[0].id).to.equal('req-1');
        });

        it('leaves the in-progress latch clear so a later request is not wedged', async function () {
            const s = makeServer(true);
            const { client } = makeClient('BTC');
            await s._handleCatchUp(client, '0', {}, 'req-1');
            expect(client.catchUpInProgress).to.not.equal(true);
        });

        it('still replays when the tip is fresh', async function () {
            const s = makeServer(false);
            const { client, frames } = makeClient('BTC');
            await s._handleCatchUp(client, '0', {}, 'req-1');
            expect(typesOf(frames, 'CATCH_UP_COMPLETE')).to.have.lengthOf(1);
            expect(typesOf(frames, 'error')).to.have.lengthOf(0);
        });

        it('rejects a malformed cursor before consulting the tip', async function () {
            let consulted = false;
            const s = makeServer(true, { isCoinTipStale: async () => { consulted = true; return true; } });
            const { client, frames } = makeClient('BTC');
            await s._handleCatchUp(client, 'abc', {}, 'req-1');
            expect(typesOf(frames, 'error')[0].data.code).to.equal('INVALID_PARAMS');
            expect(consulted).to.equal(false);
        });
    });

    describe('gate probe', function () {

        it('fails open for a db double that has no isCoinTipStale, never throwing in a send path', async function () {
            const s = makeServer(true, { isCoinTipStale: undefined });
            delete s.explorer.db.isCoinTipStale;
            expect(await s._isCoinTipStale('BTC')).to.equal(false);
        });

        it('fails open rather than propagating a gate read error', async function () {
            const s = makeServer(true, { isCoinTipStale: async () => { throw new Error('pool down'); } });
            expect(await s._isCoinTipStale('BTC')).to.equal(false);
        });
    });

    // A FROZEN replica emits nothing here (every emit is triggered by the tip
    // advancing), but one REPLAYING history from a snapshot advances while its
    // newest block_time is hours old, and pushed historical blocks as live frames.
    describe('ChangeDetector live feed', function () {

        function makeDetector(stale) {
            const calls = { checkCoin: 0, mempool: 0 };
            const d = new ChangeDetector({ db: { isCoinTipStale: async () => stale }, pollInterval: 1e9 });
            d.state = { BTC: {} };
            d.running = true;
            d._checkCoin           = async () => { calls.checkCoin++; };
            d._checkMempoolForCoin = async () => { calls.mempool++; };
            return { d, calls };
        }

        it('suppresses the whole poll for a coin whose tip is stale', async function () {
            const { d, calls } = makeDetector(true);
            await d._poll();
            expect(calls).to.deep.equal({ checkCoin: 0, mempool: 0 });
        });

        it('polls normally when the tip is fresh', async function () {
            const { d, calls } = makeDetector(false);
            await d._poll();
            expect(calls).to.deep.equal({ checkCoin: 1, mempool: 1 });
        });

        it('leaves the cursors untouched so the backlog emits once the tip catches up', async function () {
            const { d } = makeDetector(true);
            d.state.BTC = { initialized: true, blockIndex: 42, actionIndex: 7n };
            await d._poll();
            expect(d.state.BTC).to.deep.equal({ initialized: true, blockIndex: 42, actionIndex: 7n });
        });

        it('fails open for a db double with no isCoinTipStale', async function () {
            const d = new ChangeDetector({ db: {}, pollInterval: 1e9 });
            expect(await d._isCoinTipStale('BTC')).to.equal(false);
        });
    });
});
