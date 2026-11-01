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
 * A hostile since_action_index (an object String() cannot convert) draws one
 * INVALID_PARAMS frame, never an unhandled rejection or a silent drop.
 *
 ********************************************************************/

'use strict';

const { EventEmitter } = require('events');
const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../src/ws/broadcaster.js');

function setup(db) {
    const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
    s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: new EventEmitter() });
    return s;
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

const mkDb = () => ({
    getMaxActionIndex: sinon.stub().resolves(4),
    getActionsSince:   sinon.stub().resolves([])
});

const frames = (client, type) => client.ws.send.getCalls().map(c => JSON.parse(c.args[0])).filter(m => m.type === type);
async function settle() { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }

const HOSTILE = {
    'non-callable toString': () => ({ toString: 1 }),
    'empty array':           () => [],
    'true':                  () => true,
    'valueOf object':        () => ({ valueOf: () => 4 }),
    'null-prototype object': () => Object.create(null)
};

describe('catch-up cursor: hostile since_action_index', function () {
    afterEach(() => sinon.restore());

    for (const [name, make] of Object.entries(HOSTILE)) {
        it(`handleCatchUp resolves with one INVALID_PARAMS for ${name}`, async function () {
            const db = mkDb();
            const s = setup(db);
            const client = addClient(s, 1);
            await s.handleCatchUp(client, make(), {}, 'req-x');
            const errs = frames(client, 'ERROR').concat(frames(client, 'error'));
            const all = client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));
            expect(all.filter(m => m.type === 'CATCH_UP_COMPLETE')).to.have.length(0);
            expect(JSON.stringify(all)).to.contain('INVALID_PARAMS');
            expect(all.filter(m => JSON.stringify(m).includes('INVALID_PARAMS'))).to.have.length(1);
            expect(all.find(m => JSON.stringify(m).includes('INVALID_PARAMS')).id).to.equal('req-x');
            expect(errs.length).to.be.at.most(1);
            expect(db.getActionsSince.called).to.equal(false);
            expect(db.getMaxActionIndex.called).to.equal(false);
        });
    }

    it('handleSubscribe with {toString:1} replies INVALID_PARAMS and fires no unhandledRejection', async function () {
        const db = mkDb();
        const s = setup(db);
        const client = addClient(s, 2);
        const seen = [];
        const onRej = (e) => seen.push(e);
        process.on('unhandledRejection', onRej);
        try {
            s.handleSubscribe(client, { action: 'subscribe', channels: ['blocks'],
                params: { since_action_index: { toString: 1 } }, id: 'px5' });
            await settle();
        } finally {
            process.removeListener('unhandledRejection', onRej);
        }
        expect(seen).to.have.length(0);
        const all = client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));
        const bad = all.filter(m => JSON.stringify(m).includes('INVALID_PARAMS'));
        expect(bad).to.have.length(1);
        expect(bad[0].id).to.equal('px5');
        expect(all.filter(m => m.type === 'CATCH_UP_COMPLETE')).to.have.length(0);
        expect(db.getActionsSince.called).to.equal(false);
    });

    for (const v of ['4', 4, '9007199254740995']) {
        it(`a valid cursor ${JSON.stringify(v)} still completes`, async function () {
            const s = setup(mkDb());
            const client = addClient(s, 3);
            await s.handleCatchUp(client, v, {}, 'ok');
            const all = client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));
            expect(all.filter(m => JSON.stringify(m).includes('INVALID_PARAMS'))).to.have.length(0);
        });
    }
});
