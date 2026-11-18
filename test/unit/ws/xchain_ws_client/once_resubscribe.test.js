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
 * A once subscription the server spent (UNSUBSCRIBED with reason once) must not
 * be armed again by the bundled client's reconnect. The shipped scripts are
 * driven in a bare vm sandbox, the way xchain_ws_catch_up.test.js loads them.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('node:vm');
const { expect } = require('chai');

const JS_DIR = path.join(__dirname, '../../../../src/content/js');

function loadClient() {
    const timers = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        clearTimeout: (id) => { if (id) timers[id - 1] = null; }
    };
    vm.createContext(sandbox);
    for (const file of ['browser_logger.js', 'xchain_ws.js', 'xchain_ws_catch_up.js'])
        vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), sandbox, { filename: file });
    const ws = sandbox.XChainWS;
    ws.sent = [];
    ws._send = function (m) { ws.sent.push(JSON.parse(JSON.stringify(m))); };
    ws._setStatus = function () {};
    ws._reconnect = function () {};
    ws.fireTimers = () => { for (let i = 0; i < timers.length; i++) { const t = timers[i]; timers[i] = null; if (t) t(); } };
    return ws;
}

const recv = (ws, frame) => ws._onMessage({ data: JSON.stringify(frame) });
const spent = (data) => ({ type: 'UNSUBSCRIBED', data: Object.assign({ reason: 'once' }, data) });
const subscribes = (ws) => ws.sent.filter((m) => m.action === 'subscribe');

// A client holding `subscriptions` that the connection just lost, then reconnected.
function reconnect(subscriptions, cursor) {
    const ws = loadClient();
    ws.lastActionIndex = cursor === undefined ? null : cursor;
    ws.subscriptions = subscriptions;
    return ws;
}

describe('xchain_ws.js reconnect after a once subscription was spent', function () {

    it('sends nothing for a spent single-entity subscription and does not fall back to the defaults', function () {
        const ws = reconnect([{ channels: ['address'], params: { address: '1abc', once: true } }], '500');
        recv(ws, spent({ channel: 'address', address: '1abc' }));
        ws._resubscribe();
        expect(ws.sent).to.deep.equal([]);
    });

    it('still arms a once subscription nothing has spent', function () {
        const ws = reconnect([{ channels: ['address'], params: { address: '1abc', once: true } }]);
        ws._resubscribe();
        expect(subscribes(ws)).to.have.lengthOf(1);
        expect(subscribes(ws)[0].params).to.deep.equal({ address: '1abc', once: true });
    });

    it('resends only the keys of a batch that are still live, with since_action_index for the replayed channel', function () {
        const ws = reconnect([{ channels: ['address'], params: { addresses: ['1a', '1b'], once: true } }], '500');
        recv(ws, spent({ channel: 'address', address: '1a' }));
        ws._resubscribe();
        const sent = subscribes(ws);
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].channels).to.deep.equal(['address']);
        expect(sent[0].params).to.include({ address: '1b', once: true, since_action_index: '500' });
        expect(sent[0].params).to.not.have.property('addresses');
    });

    it('resends only the channels of a multi-channel request that are still live', function () {
        const ws = reconnect([{ channels: ['blocks', 'network'], params: { once: true, fields: ['block_index'] } }]);
        recv(ws, spent({ channel: 'blocks' }));
        ws._resubscribe();
        expect(subscribes(ws).map((m) => m.channels)).to.deep.equal([['network']]);
        expect(subscribes(ws)[0].params).to.deep.equal({ once: true, fields: ['block_index'] });
    });

});

// The same suite continued, kept as a second block to hold each block under the length limit.
describe('xchain_ws.js reconnect after a once subscription was spent', function () {
    it('matches market, dispenser and xcall keys the way the server spells them', function () {
        const call = 'AB'.repeat(32);
        const ws = reconnect([
            { channels: ['market'], params: { pairs: [['PEPE', 'BTC'], ['XCP', 'BTC']], once: true } },
            { channels: ['dispenser'], params: { action_indexes: [7, 8], once: true } },
            { channels: ['xcall'], params: { call_id: call, once: true } }
        ]);
        recv(ws, spent({ channel: 'market', tick1: 'PEPE', tick2: 'BTC' }));
        recv(ws, spent({ channel: 'dispenser', action_index: '7' }));
        recv(ws, spent({ channel: 'xcall', call_id: call.toLowerCase() }));
        ws._resubscribe();
        const sent = subscribes(ws);
        expect(sent.map((m) => m.channels[0])).to.deep.equal(['market', 'dispenser']);
        expect(sent[0].params).to.include({ tick1: 'XCP', tick2: 'BTC' });
        expect(sent[1].params).to.include({ action_index: 8 });
    });

    it('does not count a client-requested unsubscribe as a spend', function () {
        const ws = reconnect([{ channels: ['address'], params: { address: '1abc', once: true } }]);
        recv(ws, { type: 'UNSUBSCRIBED', data: { channel: 'address', address: '1abc', reason: 'client_request' } });
        ws._resubscribe();
        expect(subscribes(ws)).to.have.lengthOf(1);
    });

    it('does not mark a subscription that is not once', function () {
        const ws = reconnect([{ channels: ['address'], params: { address: '1abc' } }]);
        recv(ws, spent({ channel: 'address', address: '1abc' }));
        ws._resubscribe();
        expect(subscribes(ws)).to.have.lengthOf(1);
    });

    it('retries a narrowed request the server refused with RATE_LIMITED', function () {
        const ws = reconnect([{ channels: ['address'], params: { addresses: ['1a', '1b'], once: true } }]);
        recv(ws, spent({ channel: 'address', address: '1a' }));
        ws._resubscribe();
        const first = subscribes(ws)[0];
        recv(ws, { type: 'error', id: first.id, data: { code: 'RATE_LIMITED' } });
        ws.fireTimers();
        expect(subscribes(ws)).to.have.lengthOf(2);
        expect(subscribes(ws)[1].params).to.include({ address: '1b' });
    });
});
