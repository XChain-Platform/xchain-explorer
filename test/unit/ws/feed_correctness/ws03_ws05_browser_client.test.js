/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * The bundled browser client (src/content/js/xchain_ws.js plus
 * xchain_ws_catch_up.js) in a vm sandbox with a hand-driven clock and timers.
 * WS-03: a reconnect never sends faster than the server's message rate, and
 * a subscribe or catch-up the server drops with RATE_LIMITED is sent again.
 * WS-05: a REORG frame moves the cursor below the rollback.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('node:vm');
const { expect } = require('chai');

const JS_DIR = path.join(__dirname, '../../../../src/content/js');

// The shipped client over a socket that records each send with the sandbox clock.
function loadClient() {
    const timers = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        WebSocket: { OPEN: 1, CONNECTING: 0 },
        setTimeout: (fn, ms) => { timers.push({ fn, at: sandbox.now + (ms || 0) }); return timers.length; },
        clearTimeout: (id) => { if (id) timers[id - 1] = null; },
        setInterval: () => 0, clearInterval: () => {},
        now: 1000000
    };
    vm.createContext(sandbox);
    vm.runInContext('Date.now = function () { return now; };', sandbox);
    for (const file of ['browser_logger.js', 'xchain_ws.js', 'xchain_ws_catch_up.js'])
        vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), sandbox, { filename: file });
    const ws = sandbox.XChainWS;
    ws.sentAt = [];
    ws.ws = { readyState: 1, send: (raw) => ws.sentAt.push({ at: sandbox.now, msg: JSON.parse(raw) }) };
    ws._setStatus = function () {};
    // Advance the clock to `ms` from now, firing every timer that falls due, in order.
    ws.advance = (ms) => {
        const end = sandbox.now + ms;
        for (;;) {
            let next = -1;
            for (let i = 0; i < timers.length; i++) if (timers[i] && timers[i].at <= end && (next < 0 || timers[i].at < timers[next].at)) next = i;
            if (next < 0) break;
            const t = timers[next]; timers[next] = null;
            sandbox.now = Math.max(sandbox.now, t.at);
            t.fn();
        }
        sandbox.now = end;
    };
    return ws;
}

const recv = (ws, frame) => ws._onMessage({ data: JSON.stringify(frame) });
const subscribes = (ws) => ws.sentAt.filter((s) => s.msg.action === 'subscribe');

// The server's leaky bucket (subscriptions.js overRateLimit) over the recorded sends:
// the messages it would refuse.
function overRate(sends, rate) {
    let level = 0, last = null, refused = 0;
    for (const s of sends) {
        if (last !== null) level = Math.max(0, level - ((s.at - last) / 1000) * rate);
        last = s.at;
        level += 1;
        if (level > rate) refused++;
    }
    return refused;
}

function trackSubscriptions(ws, n) {
    ws.subscriptions = [];
    for (let i = 0; i < n; i++) ws.subscriptions.push({ channels: ['token'], params: { tick: 'T' + i } });
}

describe('WS-03: the browser client paces its resubscribe', function () {

    it('sends a 25-subscription reconnect without exceeding the server rate, and sends all of it', function () {
        const ws = loadClient();
        trackSubscriptions(ws, 25);
        ws._resubscribe();
        expect(subscribes(ws).length).to.be.lessThan(10);
        ws.advance(5000);

        expect(subscribes(ws)).to.have.lengthOf(25);
        expect(overRate(ws.sentAt, 10)).to.equal(0);
        expect(new Set(subscribes(ws).map((s) => s.msg.params.tick)).size).to.equal(25);
    });

    it('paces to the rate WELCOME advertises', function () {
        const ws = loadClient();
        recv(ws, { type: 'WELCOME', data: { version: '1', latest_block_index: '1', latest_action_index: '0', limits: { max_message_rate: 4 } } });
        trackSubscriptions(ws, 12);
        ws._resubscribe();
        ws.advance(6000);

        expect(subscribes(ws)).to.have.lengthOf(12);
        expect(overRate(ws.sentAt, 4)).to.equal(0);
    });
});

describe('WS-03: the browser client sends a dropped request again', function () {

    it('sends a subscribe again when the server drops it with RATE_LIMITED naming its id', function () {
        const ws = loadClient();
        trackSubscriptions(ws, 2);
        ws._resubscribe();
        const dropped = subscribes(ws)[1].msg;
        expect(dropped.id).to.be.a('string');
        recv(ws, { type: 'error', id: dropped.id, data: { code: 'RATE_LIMITED', message: 'slow down' } });
        ws.advance(1000);

        const again = subscribes(ws).slice(2);
        expect(again).to.have.lengthOf(1);
        expect(again[0].msg.params).to.deep.equal(dropped.params);
        expect(again[0].msg.id).to.not.equal(dropped.id);
    });

    it('sends a catch-up again on RATE_LIMITED instead of reporting resync_required', function () {
        const ws = loadClient();
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        ws.lastActionIndex = '500';
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();
        const first = subscribes(ws)[0].msg;
        recv(ws, { type: 'error', id: first.id, data: { code: 'RATE_LIMITED', message: 'slow down' } });
        ws.advance(1000);

        expect(events).to.have.lengthOf(0);
        const again = subscribes(ws)[1].msg;
        expect(again.params.since_action_index).to.equal('500');
    });

    // WS-04's retryable refusal takes the same path.
    it('sends a catch-up again after a second on CATCH_UP_NOT_READY', function () {
        const ws = loadClient();
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        ws.lastActionIndex = '500';
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();
        const first = subscribes(ws)[0].msg;
        recv(ws, { type: 'error', id: first.id, data: { code: 'CATCH_UP_NOT_READY', message: 'retry shortly' } });
        ws.advance(500);
        expect(subscribes(ws)).to.have.lengthOf(1);
        ws.advance(600);

        expect(events).to.have.lengthOf(0);
        expect(subscribes(ws)[1].msg.params.since_action_index).to.equal('500');
    });
});

describe('WS-05: the browser client applies REORG to its cursor', function () {

    it('drops the cursor below the first invalidated index, then follows the replacements', function () {
        const ws = loadClient();
        ws.lastActionIndex = '130';
        recv(ws, { type: 'REORG', data: { fork_block_index: '11', first_invalid_action_index: '101' } });
        expect(ws.lastActionIndex).to.equal('100');
        recv(ws, { type: 'NEW_ACTION', data: { action_index: '105' } });
        expect(ws.lastActionIndex).to.equal('105');
    });

    it('leaves a cursor that is already below the rollback where it is', function () {
        const ws = loadClient();
        ws.lastActionIndex = '90';
        recv(ws, { type: 'REORG', data: { fork_block_index: '11', first_invalid_action_index: '101' } });
        expect(ws.lastActionIndex).to.equal('90');
    });
});
