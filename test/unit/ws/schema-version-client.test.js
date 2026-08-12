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
 * Conformance test: the bundled browser WS client (src/content/js/xchain-ws.js)
 * hardcodes CLIENT_WS_SCHEMA_VERSION because it is a plain, un-bundled script
 * that cannot require() src/ws/schema-version.js's WS_SCHEMA_VERSION. This test
 * fails if the two values are ever allowed to drift, which would otherwise make
 * the first-party UI warn (or fail to warn) incorrectly against its own server.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { WS_SCHEMA_VERSION } = require('../../../src/ws/schema-version.js');

describe('xchain-ws.js CLIENT_WS_SCHEMA_VERSION conformance', function () {

    it('matches src/ws/schema-version.js WS_SCHEMA_VERSION', function () {
        const clientPath = path.join(__dirname, '../../../src/content/js/xchain-ws.js');
        const source      = fs.readFileSync(clientPath, 'utf8');
        const match       = source.match(/var\s+CLIENT_WS_SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
        expect(match, 'CLIENT_WS_SCHEMA_VERSION declaration not found in xchain-ws.js').to.not.equal(null);
        const clientVersion = Number(match[1]);
        expect(clientVersion).to.equal(WS_SCHEMA_VERSION);
    });

    it('resets _schemaWarned in _onOpen and declares it in the state block (SDK parity)', function () {
        // api-contracts finding: _schemaWarned was an undeclared expando that was
        // never reset on reconnect, so a page that reconnected to an
        // upgraded server stayed silent after the first warning. The SDK client
        // (xchain-sdk/src/websocket.js) resets the flag in its 'open' handler;
        // this client must do the same.
        const clientPath = path.join(__dirname, '../../../src/content/js/xchain-ws.js');
        const source      = fs.readFileSync(clientPath, 'utf8');

        const stateBlockMatch = source.match(/var\s+XChainWS\s*=\s*\{([\s\S]*?)_onOpen:/);
        expect(stateBlockMatch, 'could not locate XChainWS state block').to.not.equal(null);
        expect(stateBlockMatch[1]).to.match(/_schemaWarned\s*:\s*false\s*,/);

        const onOpenMatch = source.match(/_onOpen:\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\},/);
        expect(onOpenMatch, 'could not locate _onOpen handler').to.not.equal(null);
        expect(onOpenMatch[1]).to.match(/this\._schemaWarned\s*=\s*false\s*;/);
    });

});

// The bundled client carried the same coerce-then-replay-as-cursor bug as the SDK
// client. It tracked action_index through Number(), which rounds above 2^53, and
// sent the rounded value back as since_action_index on reconnect, asking the
// server for rows after an action the page had never been shown. The object is a
// plain browser global with no load-time DOM access, so it evaluates in a bare vm
// sandbox and the real shipped methods can be driven directly.
describe('xchain-ws.js catch-up cursor precision', function () {

    function loadClient() {
        const vm = require('node:vm');
        const clientPath = path.join(__dirname, '../../../src/content/js/xchain-ws.js');
        const sandbox = { console: { log() {}, warn() {}, error() {} } };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(clientPath, 'utf8'), sandbox, { filename: 'xchain-ws.js' });
        return sandbox.XChainWS;
    }

    it('keeps an above-2^53 action_index exact instead of rounding it', function () {
        const ws = loadClient();
        ws._onMessage({ data: JSON.stringify({ type: 'NEW_ACTION', data: { action_index: '9007199254740995' } }) });
        expect(ws.lastActionIndex).to.equal('9007199254740995');
        expect(String(Number(ws.lastActionIndex))).to.equal('9007199254740996');
    });

    it('replays the cursor byte-for-byte as since_action_index', function () {
        const ws = loadClient();
        const sent = [];
        ws._send = function (m) { sent.push(m); };
        ws._onMessage({ data: JSON.stringify({ type: 'NEW_ACTION', data: { action_index: '9007199254740995' } }) });
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params.since_action_index).to.equal('9007199254740995');
    });

    it('a WELCOME of "0" seeds the cursor but sends no since_action_index', function () {
        const ws = loadClient();
        const sent = [];
        ws._send = function (m) { sent.push(m); };
        ws._onMessage({ data: JSON.stringify({ type: 'WELCOME', data: { version: '1', latest_block_index: '0', latest_action_index: '0' } }) });
        expect(ws.lastActionIndex).to.equal('0');
        ws.subscriptions = [{ channels: ['actions'], params: {} }];
        ws._resubscribe();
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].params).to.not.have.property('since_action_index');
    });

    it('never moves the cursor backwards', function () {
        const ws = loadClient();
        ws._onMessage({ data: JSON.stringify({ type: 'NEW_ACTION', data: { action_index: '505' } }) });
        ws._onMessage({ data: JSON.stringify({ type: 'NEW_ACTION', data: { action_index: '499' } }) });
        expect(ws.lastActionIndex).to.equal('505');
    });

});
