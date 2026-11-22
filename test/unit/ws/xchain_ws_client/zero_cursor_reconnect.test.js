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
 * Reconnect catch-up coverage for the zero action cursor.
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('node:vm');
const { expect } = require('chai');

const JS_DIR = path.join(__dirname, '../../../../src/content/js');

function loadClient() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout() { return 0; },
        clearTimeout() {}
    };
    vm.createContext(sandbox);
    for (const file of ['browser_logger.js', 'xchain_ws.js', 'xchain_ws_catch_up.js'])
        vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), sandbox, { filename: file });
    const ws = sandbox.XChainWS;
    ws.sent = [];
    ws._send = (message) => ws.sent.push(JSON.parse(JSON.stringify(message)));
    return ws;
}

const catchUps = (ws) => ws.sent.filter((message) => message.params && message.params.since_action_index !== undefined);
const recv = (ws, frame) => ws._onMessage({ data: JSON.stringify(frame) });

describe('xchain_ws.js reconnect from cursor zero', function () {
    it('rewinds below the first action and replays from zero', function () {
        const ws = loadClient();
        ws.lastActionIndex = '5';
        ws._rewindCursor('1');
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();

        expect(ws.lastActionIndex).to.equal('0');
        expect(catchUps(ws)[0].params.since_action_index).to.equal('0');
    });

    it('keeps a never-seeded null cursor as a plain subscription', function () {
        const ws = loadClient();
        ws.lastActionIndex = null;
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();

        expect(ws.sent).to.have.lengthOf(1);
        expect(ws.sent[0].params).to.not.have.property('since_action_index');
    });

    it('advances from zero when its catch-up completes', function () {
        const ws = loadClient();
        ws.lastActionIndex = '0';
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();
        const request = catchUps(ws)[0];
        recv(ws, { type: 'CATCH_UP_COMPLETE', id: request.id,
            data: { events_replayed: 3, latest_action_index: '3', truncated: false } });

        expect(ws.lastActionIndex).to.equal('3');
    });
});
