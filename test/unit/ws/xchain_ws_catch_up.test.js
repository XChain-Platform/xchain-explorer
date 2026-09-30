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
 * The bundled browser client's reconnect catch-up (src/content/js/xchain_ws.js
 * plus xchain_ws_catch_up.js), driven in a bare vm sandbox the way
 * schema_version_client.test.js loads it:
 * the cursor never jumps past rows a replay has yet to deliver, catch-ups go
 * out one at a time, a truncated replay is continued, and a refused or
 * unanswered one is reported to the page.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('node:vm');
const { expect } = require('chai');

const JS_DIR = path.join(__dirname, '../../../src/content/js');

// Load the shipped client, in the page's script order, with timers the test fires by hand.
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
const catchUps = (ws) => ws.sent.filter(m => m.params && m.params.since_action_index !== undefined);
const complete = (id, latest, extra) => ({ type: 'CATCH_UP_COMPLETE', id, data: { events_replayed: 1, latest_action_index: latest, truncated: false, ...(extra || {}) } });

function reconnectWith(ws, cursor, subscriptions) {
    ws.lastActionIndex = cursor;
    ws.subscriptions = subscriptions;
    ws._resubscribe();
}

describe('xchain_ws.js reconnect catch-up: load order and sequencing', function () {

    it('the page shell loads xchain_ws_catch_up.js right after xchain_ws.js', function () {
        const shell   = fs.readFileSync(path.join(__dirname, '../../../src/content/html/template.html'), 'utf8');
        const scripts = [...shell.matchAll(/<script[^>]*src="\/js\/(xchain_ws[a-z_]*\.js)"/g)].map(m => m[1]);
        expect(scripts).to.deep.equal(['xchain_ws.js', 'xchain_ws_catch_up.js']);
    });

    it('WELCOME does not move a cursor that is already set', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        recv(ws, { type: 'WELCOME', data: { version: '1', latest_block_index: '9', latest_action_index: '900' } });
        expect(ws.lastActionIndex).to.equal('500');

        const idle = loadClient();
        idle.lastActionIndex = '500';
        recv(idle, { type: 'WELCOME', data: { version: '1', latest_block_index: '9', latest_action_index: '900' } });
        expect(idle.lastActionIndex).to.equal('500');
    });

    it('sends one catch-up at a time, each from the reconnect-time cursor, and none for blocks/network', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [
            { channels: ['blocks', 'network'], params: {} },
            { channels: ['actions'], params: { types: ['SEND'] } },
            { channels: ['address'], params: { address: 'X' } }
        ]);
        expect(ws.sent[0].channels).to.deep.equal(['blocks', 'network']);
        expect(ws.sent[0].params).to.not.have.property('since_action_index');
        expect(catchUps(ws)).to.have.lengthOf(1);
        const first = catchUps(ws)[0];
        expect(first.channels).to.deep.equal(['actions']);
        expect(first.params.since_action_index).to.equal('500');
        expect(first.id).to.be.a('string');

        recv(ws, { type: 'NEW_ACTION', catch_up: true, data: { action_index: '520' } });
        recv(ws, complete(first.id, '520'));
        expect(catchUps(ws)).to.have.lengthOf(2);
        const second = catchUps(ws)[1];
        expect(second.channels).to.deep.equal(['address']);
        expect(second.params.since_action_index).to.equal('500');
        expect(second.id).to.not.equal(first.id);
    });
});

describe('xchain_ws.js reconnect catch-up: cursor, continuation and refusal', function () {

    it('holds the cursor against live frames until every replay closes, then applies the highest seen', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        const id = catchUps(ws)[0].id;
        recv(ws, { type: 'NEW_ACTION', data: { action_index: '950' } });
        expect(ws.lastActionIndex).to.equal('500');

        recv(ws, complete(id, '600'));
        expect(ws.lastActionIndex).to.equal('950');
        expect(ws._catchUp).to.equal(null);
    });

    it('continues a truncated replay from where the server stopped', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        const id = catchUps(ws)[0].id;
        recv(ws, complete(id, '600', { truncated: true }));

        expect(catchUps(ws)).to.have.lengthOf(2);
        const again = catchUps(ws)[1];
        expect(again.params.since_action_index).to.equal('600');
        expect(again.id).to.not.equal(id);
        expect(ws.lastActionIndex).to.equal('500');

        recv(ws, complete(again.id, '640'));
        expect(ws.lastActionIndex).to.equal('640');
    });

    it('reports a refused catch-up to the page and moves on to the next subscription', function () {
        const ws = loadClient();
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }, { channels: ['address'], params: { address: 'X' } }]);
        const id = catchUps(ws)[0].id;
        recv(ws, { type: 'error', id, data: { code: 'CATCH_UP_TOO_OLD', message: 'backfill via REST' } });

        expect(events).to.have.lengthOf(1);
        expect(events[0].code).to.equal('CATCH_UP_TOO_OLD');
        expect(events[0].since_action_index).to.equal('500');
        expect(catchUps(ws)).to.have.lengthOf(2);
    });
});

describe('xchain_ws.js reconnect catch-up: backstops', function () {

    it('ignores an error frame that answers some other request', function () {
        const ws = loadClient();
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        recv(ws, { type: 'error', id: 'someone-else', data: { code: 'INVALID_PARAMS' } });
        expect(events).to.have.lengthOf(0);
        expect(ws._catchUp).to.not.equal(null);
    });

    it('treats an unanswered catch-up as refused when the backstop timer fires', function () {
        const ws = loadClient();
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        ws.fireTimers();

        expect(events.map(e => e.code)).to.deep.equal(['CATCH_UP_TIMEOUT']);
        expect(ws._catchUp).to.equal(null);
    });

    it('a disconnect mid catch-up keeps the cursor before the gap, so the next reconnect replays it', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        recv(ws, { type: 'NEW_ACTION', catch_up: true, data: { action_index: '520' } });
        recv(ws, { type: 'NEW_ACTION', data: { action_index: '950' } });
        ws._onClose({ code: 1006 });

        ws.sent = [];
        ws._resubscribe();
        expect(catchUps(ws)[0].params.since_action_index).to.equal('500');
    });

    it('stops continuing after the round cap and reports the gap', function () {
        const ws = loadClient();
        ws.catchUpMaxRounds = 2;
        const events = [];
        ws.on('resync_required', (m) => events.push(m.data));
        reconnectWith(ws, '500', [{ channels: ['actions'], params: {} }]);
        recv(ws, complete(catchUps(ws)[0].id, '600', { truncated: true }));
        recv(ws, complete(catchUps(ws)[1].id, '700', { truncated: true }));

        expect(catchUps(ws)).to.have.lengthOf(2);
        expect(events.map(e => e.code)).to.deep.equal(['CATCH_UP_ROUNDS']);
    });

    it('does not re-arm a once subscription its replay already spent', function () {
        const ws = loadClient();
        reconnectWith(ws, '500', [{ channels: ['address'], params: { address: 'X', once: true } }]);
        recv(ws, complete(catchUps(ws)[0].id, '600', { truncated: true, events_replayed: 1 }));
        expect(catchUps(ws)).to.have.lengthOf(1);
        expect(ws._catchUp).to.equal(null);
    });
});
