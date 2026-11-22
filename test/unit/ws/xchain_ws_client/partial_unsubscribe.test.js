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
 * Partial unsubscribe coverage for tracked browser subscriptions.
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
    ws._send = (message) => ws.sent.push(JSON.parse(JSON.stringify(message)));
    ws.fireTimers = () => { for (let i = 0; i < timers.length; i++) { const fn = timers[i]; timers[i] = null; if (fn) fn(); } };
    return ws;
}

const recv = (ws, frame) => ws._onMessage({ data: JSON.stringify(frame) });
const subscribes = (ws) => ws.sent.filter((message) => message.action === 'subscribe');

function reconnectAfter(ws, channels, params, unsubscribeChannels, unsubscribeParams) {
    ws.lastActionIndex = '500';
    ws.subscriptions = [{ channels, params }];
    ws.unsubscribe(unsubscribeChannels, unsubscribeParams);
    ws.sent = [];
    ws._resubscribe();
    return subscribes(ws);
}

describe('xchain_ws.js partial unsubscribe tracking', function () {
    it('resubscribes only the remaining address in a batch', function () {
        const sent = reconnectAfter(loadClient(), ['address'], { addresses: ['A', 'B'] }, ['address'], { address: 'A' });
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params).to.include({ address: 'B', since_action_index: '500' });
        expect(sent[0].params).to.not.have.property('addresses');
    });

    it('resubscribes only the remaining global channel', function () {
        const sent = reconnectAfter(loadClient(), ['blocks', 'network'], {}, ['blocks'], {});
        expect(sent.map((message) => message.channels)).to.deep.equal([['network']]);
    });

    it('matches an entity despite different filter params', function () {
        const sent = reconnectAfter(loadClient(), ['address'], { address: 'A', fields: ['balance'] }, ['address'], { address: 'A' });
        expect(sent.some((message) => message.channels.indexOf('address') !== -1)).to.equal(false);
    });

    it('removes an exact full subscription from the tracked list', function () {
        const ws = loadClient();
        ws.subscriptions = [{ channels: ['address'], params: { address: 'A' } }];
        ws.unsubscribe(['address'], { address: 'A' });
        expect(ws.subscriptions).to.deep.equal([]);
    });
});

describe('xchain_ws.js partial unsubscribe tracking', function () {
    it('removes the key from every saved entry and permits a later resubscribe', function () {
        const ws = loadClient();
        ws.subscriptions = [
            { channels: ['address'], params: { addresses: ['A', 'B'] } },
            { channels: ['address'], params: { address: 'A', fields: ['balance'] } }
        ];
        ws.unsubscribe(['address'], { address: 'A' });
        ws.subscribe(['address'], { address: 'A' });
        ws.sent = [];
        ws._resubscribe();
        const addresses = subscribes(ws).map((message) => message.params.address);
        expect(addresses.sort()).to.deep.equal(['A', 'B']);
    });

    it('narrows market pairs and normalizes xcall ids', function () {
        const call = 'AB'.repeat(32);
        const ws = loadClient();
        ws.subscriptions = [
            { channels: ['market'], params: { pairs: [['PEPE', 'BTC'], ['XCP', 'BTC']] } },
            { channels: ['xcall'], params: { call_id: call.toLowerCase() } }
        ];
        ws.unsubscribe(['market'], { tick1: 'PEPE', tick2: 'BTC' });
        ws.unsubscribe(['xcall'], { call_id: call });
        ws.sent = [];
        ws._resubscribe();
        const sent = subscribes(ws);
        expect(sent.map((message) => message.channels[0])).to.deep.equal(['market']);
        expect(sent[0].params).to.include({ tick1: 'XCP', tick2: 'BTC' });
    });
});

describe('xchain_ws.js partial unsubscribe tracking', function () {
    it('does not revive an unsubscribed key in a rate-limit retry', function () {
        const ws = loadClient();
        ws.subscribe(['address'], { addresses: ['A', 'B'] });
        const first = subscribes(ws)[0];
        recv(ws, { type: 'error', id: first.id, data: { code: 'RATE_LIMITED' } });
        ws.unsubscribe(['address'], { address: 'A' });
        ws.sent = [];
        ws.fireTimers();
        const sent = subscribes(ws);
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params).to.include({ address: 'B' });
    });

    it('retries only the narrowed request that was rate limited', function () {
        const ws = loadClient();
        ws.subscriptions = [{ channels: ['address'], params: { addresses: ['A', 'B', 'C'] } }];
        ws.unsubscribe(['address'], { address: 'A' });
        ws.sent = [];
        ws._resubscribe();
        const initial = subscribes(ws);
        const refused = initial.find((message) => message.params.address === 'B');
        recv(ws, { type: 'error', id: refused.id, data: { code: 'RATE_LIMITED' } });
        ws.fireTimers();

        const retried = subscribes(ws).slice(initial.length);
        expect(retried.map((message) => message.params.address)).to.deep.equal(['B']);
    });

    it('ignores an entity unsubscribe without an entity key', function () {
        const ws = loadClient();
        ws.subscriptions = [{ channels: ['address'], params: { address: 'A' } }];
        ws.unsubscribe(['address'], {});
        expect(ws.subscriptions).to.have.lengthOf(1);
    });
});

describe('xchain_ws.js partial unsubscribe address spelling', function () {
    const LOWER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const BASE58 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

    it('matches a bech32 address saved in uppercase to its lowercase unsubscribe', function () {
        const sent = reconnectAfter(loadClient(), ['address'], { addresses: [LOWER.toUpperCase(), 'B'] }, ['address'], { address: LOWER });
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params).to.include({ address: 'B' });
    });

    it('matches a bech32 address saved in lowercase to its uppercase unsubscribe', function () {
        const sent = reconnectAfter(loadClient(), ['address'], { address: LOWER }, ['address'], { address: LOWER.toUpperCase() });
        expect(sent.some((message) => message.channels.indexOf('address') !== -1)).to.equal(false);
    });

    it('keeps case-sensitive addresses distinct', function () {
        const sent = reconnectAfter(loadClient(), ['address'], { address: BASE58 }, ['address'], { address: BASE58.toLowerCase() });
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params).to.include({ address: BASE58 });
    });
});
