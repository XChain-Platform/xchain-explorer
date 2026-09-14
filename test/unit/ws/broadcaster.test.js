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
 * Unit tests for Broadcaster (src/ws/broadcaster.js)
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const EventEmitter = require('events');
const ChannelManager = require('../../../src/ws/channel_manager.js');
const Broadcaster    = require('../../../src/ws/broadcaster.js');

// A socket the broadcaster will actually send on: OPEN, and with nothing queued,
// because the backpressure gate silently skips any client whose buffered bytes sit
// above the cap.
function createMockWs() {
    return {
        readyState:     1, // OPEN
        bufferedAmount: 0,
        send:           sinon.stub()
    };
}

// A connected client the way the server tracks one. Its coin is half of every channel
// key it can receive on, and `subscriptions` is the set a spent once-subscription is
// removed from.
function createClient(id, coin, ws) {
    return {
        id:            id,
        coin:          coin || 'BTC',
        chain:         'BTC',
        network:       'mainnet',
        subscriptions: new Set(),
        ws:            ws || createMockWs()
    };
}

// The broadcaster never calls the change detector, it only listens to it, so a bare
// EventEmitter is a complete stand-in: emitting on it is exactly what a real poll does.
function createMockChangeDetector() {
    return new EventEmitter();
}

// The two things the broadcaster reads off its server: a REAL ChannelManager, so
// routing and filters are exercised rather than faked, and the client map it looks
// each subscriber up in.
function createMockWsServer() {
    const cm = new ChannelManager({ maxSubscriptions: 25 });
    const clients = new Map();
    return {
        channelManager: cm,
        getClients:     () => clients,
        clients:        clients,
        addClient: function(client) {
            clients.set(client.id, client);
        }
    };
}

function createHarness() {
    const wsServer = createMockWsServer();
    const changeDetector = createMockChangeDetector();
    const broadcaster = new Broadcaster({
        wsServer,
        changeDetector,
        maxBackpressure: 65536
    });
    return { wsServer, changeDetector, broadcaster };
}

module.exports = { sinon, expect, createMockWs, createClient, createHarness };
require('./broadcaster.test/block_and_action_events.js');
require('./broadcaster.test/routing_and_lifecycle.js');
require('./broadcaster.test/entity_updates.js');
