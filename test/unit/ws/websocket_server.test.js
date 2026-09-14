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
 * Stress-sweep unit tests for src/ws/websocket_server.js:
 *   - ws-1: per-IP cap key must not trust a spoofable X-Forwarded-For token
 *   - ws-2: snapshot-on-subscribe must not re-fire for already-subscribed entities
 */

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const WebSocketServer = require('../../../src/ws/websocket_server.js');

function makeServer(opts = {}) {
    return new WebSocketServer({ explorer: { db: {} }, broadcaster: null, ...opts });
}

function makeReq(headers, remoteAddress) {
    return { headers: headers || {}, socket: { remoteAddress: remoteAddress || '203.0.113.9' } };
}

// A client shaped like onConnection builds, with a closed ws so send is a no-op.
function makeClient(coin) {
    return {
        id: 1, coin: coin || 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 0, send: () => {} },
        subscriptions: new Set(),
        snapshotInProgress: false,
        catchUpInProgress: false
    };
}

module.exports = { expect, sinon, makeServer, makeReq, makeClient };

require('./websocket_server.test/support/subscriptions.js');
require('./websocket_server.test/support/protocol.js');
require('./websocket_server.test/support/limits.js');
require('./websocket_server.test/support/snapshots.js');
