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
 * Lifecycle frames of actions the indexer mints itself (matches and expiry
 * passes) name their parties in `destinations`, read once per poll or replay,
 * and reach those parties' address channels live and on catch-up replay. The
 * NEW_ACTION of such an action still goes to the actions channel only.
 * Unit tests for src/ws/change_detector/lifecycle.js, extractAddresses in
 * src/ws/broadcaster/channels.js and the replay batch in catch_up.js.
 */

'use strict';

const { EventEmitter } = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const { mk } = require('../change_detector_methods.test/support/helpers.js');
const partyReaders    = require('../../../../src/db/readers/action_detail_io/lifecycle_parties.js');
const ChangeDetector  = require('../../../../src/ws/change_detector.js');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../src/ws/broadcaster.js');

const systemRow = (i, action) => ({ action, action_index: i, block_index: 10, source: null, destinations: [] });

// A detector polling `actions` over the real party reader, whose one statement
// answers party `p<index>` for every index it binds, or rejects with `fail`.
function pollWith(actions, fail) {
    const det = mk();
    det.db.util = { isNull: (v) => v === null || v === undefined };
    det.db.getLifecycleParties = partyReaders.getLifecycleParties;
    det.db.doQuery = fail ? sinon.stub().rejects(fail)
        : sinon.stub().callsFake(async (config, sql, args) => args.map((i) => ({ action_index: i, address: 'p' + i })));
    det.state.BTC = { blockIndex: 0, actionIndex: 0n, initialized: true };
    det.db.getMaxActionIndex.resolves(BigInt(actions.length));
    det.db.getActionsSince.resolves(actions);
    const frames = [];
    det.on('lifecycle_event', (c, e) => frames.push(e));
    return { det, frames };
}

describe('lifecycle frames of source-less system actions name their parties', function () {
    afterEach(() => sinon.restore());

    it('puts the parties in destinations and leaves source null', async function () {
        const { det, frames } = pollWith([systemRow(1n, 'ORDER_MATCH'), systemRow(2n, 'DISPENSER_EXPIRE')]);
        await det.checkCoin('BTC');
        expect(frames.map((f) => [f.type, f.data.source, f.data.destinations])).to.deep.equal([
            ['ORDER_MATCH', null, ['p1']], ['DISPENSER_EXPIRED', null, ['p2']]
        ]);
    });

    it('reads parties in one statement per poll whatever the batch size', async function () {
        const types = ['ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP_MATCH', 'SWAP_EXPIRE', 'COINPAY_EXPIRE', 'BET_EXPIRE'];
        for (const size of [2, 24]) {
            const rows = Array.from({ length: size }, (_, i) => systemRow(BigInt(i + 1), types[i % types.length]));
            const { det, frames } = pollWith(rows);
            await det.checkCoin('BTC');
            expect(det.db.doQuery.callCount, 'statements at ' + size).to.equal(1);
            expect(frames).to.have.lengthOf(size);
        }
    });

    it('issues no read for a batch with no system action', async function () {
        const rows = [{ action: 'DISPENSE', action_index: 1n, source: '1buyer', destinations: [] },
            { action: 'SEND', action_index: 2n, source: '1a', destinations: ['1b'] }];
        const { det, frames } = pollWith(rows);
        await det.checkCoin('BTC');
        expect(det.db.doQuery.called).to.equal(false);
        expect(frames.map((f) => f.data.destinations)).to.deep.equal([undefined]);
    });

    it('still emits the frame without destinations when the party read fails', async function () {
        const { det, frames } = pollWith([systemRow(1n, 'ORDER_MATCH'), systemRow(2n, 'SWAP_EXPIRE')], new Error('down'));
        await det.checkCoin('BTC');
        expect(frames.map((f) => [f.type, f.data.destinations])).to.deep.equal([
            ['ORDER_MATCH', undefined], ['SWAP_EXPIRED', undefined]
        ]);
        expect(det.db.doQuery.callCount).to.equal(1);
        expect(det.state.BTC.actionIndex).to.equal(2n);
    });
});

describe('extractAddresses reads the destinations of a lifecycle payload', function () {
    it('adds every named party beside the singular fields and skips empty entries', function () {
        const b = new Broadcaster({ wsServer: { clients: new Map() }, changeDetector: new EventEmitter() });
        const got = b.extractAddresses({ source: null, payer_address: '1payer', destinations: ['1a', '', null, '1payer'] });
        expect([...got]).to.deep.equal(['1payer', '1a']);
        expect([...b.extractAddresses({ source: '1s' })]).to.deep.equal(['1s']);
    });
});

const ROWS = [systemRow(5, 'ORDER_MATCH'), systemRow(6, 'ORDER_EXPIRE')];
const PARTIES = new Map([['5', new Set(['1maker', '1taker'])], ['6', new Set(['1maker'])]]);

function setup() {
    const db = {
        getMaxActionIndex:       sinon.stub().resolves(6),
        getActionsSince:         sinon.stub().resolves(ROWS),
        getOrderMatchSettlement: sinon.stub().resolves(null),
        getLifecycleParties:     sinon.stub().resolves(PARTIES)
    };
    const detector = new ChangeDetector({ db });
    const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
    s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: detector });
    return { db, detector, s };
}

function addClient(s, id) {
    const client = {
        id, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
    s.clients.set(id, client);
    return client;
}

const sent = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]))
    .filter((m) => !['SUBSCRIBED', 'CATCH_UP_COMPLETE'].includes(m.type))
    .map((m) => [m.type, m.data.action_index, m.data.destinations]);

async function settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

describe('system action lifecycle frames reach their parties address channels', function () {
    afterEach(() => sinon.restore());

    it('delivers live and on replay to a named party only, with no address NEW_ACTION', async function () {
        const { db, detector, s } = setup();
        const party = addClient(s, 1);
        const bystander = addClient(s, 2);
        const replayed = addClient(s, 3);
        s.handleSubscribe(party, { action: 'subscribe', channels: ['address'], params: { address: '1maker' }, id: 'a' });
        s.handleSubscribe(bystander, { action: 'subscribe', channels: ['address'], params: { address: '1other' }, id: 'b' });
        const batch = { actions: ROWS, parties: undefined };
        for (const row of ROWS) {
            detector.emit('action', 'BTC', row);
            await detector.emitLifecycleEvents('BTC', { coin: 'BTC' }, row, batch);
        }
        expect(db.getLifecycleParties.callCount).to.equal(1);

        s.handleSubscribe(replayed, { action: 'subscribe', channels: ['address'],
            params: { address: '1maker', since_action_index: '0' }, id: 'r' });
        await settle();

        const expected = [['ORDER_MATCH', 5, ['1maker', '1taker']], ['ORDER_EXPIRED', 6, ['1maker']]];
        expect(sent(party)).to.deep.equal(expected);
        expect(sent(replayed)).to.deep.equal(expected);
        expect(sent(bystander)).to.deep.equal([]);
        expect(db.getLifecycleParties.callCount).to.equal(2);
    });

    it('reads parties once per catch-up replay whatever the replay size', async function () {
        for (const size of [2, 30]) {
            const rows = Array.from({ length: size }, (_, i) => systemRow(i + 1, i % 2 ? 'SWAP_EXPIRE' : 'ORDER_EXPIRE'));
            const { db, s } = setup();
            db.getMaxActionIndex.resolves(size);
            db.getActionsSince.resolves(rows);
            const client = addClient(s, 1);
            s.handleSubscribe(client, { action: 'subscribe', channels: ['actions'], params: { since_action_index: '0' }, id: 'r' });
            await settle();
            expect(db.getLifecycleParties.callCount, 'reads at ' + size).to.equal(1);
            expect(sent(client).filter((f) => f[0] !== 'NEW_ACTION')).to.have.lengthOf(size);
        }
    });
});
