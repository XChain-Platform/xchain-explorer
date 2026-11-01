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
 * A frame with a missing or non-string action is refused with one typed
 * INVALID_ACTION error that echoes the request id when the frame carries one.
 *
 ********************************************************************/

'use strict';

const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');

function setup() {
    const s = new WebSocketServer({ explorer: { db: {} }, broadcaster: null });
    const client = {
        id: 1, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), msgCount: 0, msgLastRefill: Date.now()
    };
    s.clients.set(1, client);
    return { s, client };
}

const sent = client => client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));

function feed(frame) {
    const { s, client } = setup();
    s.onMessage(client, Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)));
    return sent(client);
}

describe('missing or non-string action refusal', function () {
    afterEach(() => sinon.restore());

    const cases = [
        ['missing action',     { id: 'x1' },                   'x1'],
        ['numeric action',     { id: 'x2', action: 5 },        'x2'],
        ['null action',        { id: 'x3', action: null },     'x3'],
        ['object action',      { id: 'x4', action: {} },       'x4'],
        ['numeric id echoed',  { id: 7 },                      7]
    ];
    for (const [name, frame, id] of cases) {
        it(name + ' echoes the request id on one INVALID_ACTION', function () {
            const out = feed(frame);
            expect(out).to.have.lengthOf(1);
            expect(out[0].type).to.equal('error');
            expect(out[0].data.code).to.equal('INVALID_ACTION');
            expect(out[0].data.message).to.equal('Missing action field');
            expect(out[0].id).to.equal(id);
        });
    }

    for (const [name, frame] of [['empty object', {}], ['bare array', [1, 2]], ['array with id-like entry', [{ id: 'a' }]]]) {
        it(name + ' is refused with no id field', function () {
            const out = feed(frame);
            expect(out).to.have.lengthOf(1);
            expect(out[0].data.code).to.equal('INVALID_ACTION');
            expect(out[0]).to.not.have.property('id');
        });
    }

    for (const raw of ['null', '42', '"s"', 'true']) {
        it('non-object frame ' + raw + ' does not throw and is refused without an id', function () {
            const out = feed(raw);
            expect(out).to.have.lengthOf(1);
            expect(out[0].data.code).to.equal('INVALID_ACTION');
            expect(out[0]).to.not.have.property('id');
        });
    }
});
