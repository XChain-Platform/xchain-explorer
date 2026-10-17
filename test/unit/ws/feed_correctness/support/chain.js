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
 * Shared fixture for the feed correctness regressions (WS-01 to WS-10): an
 * in-memory chain behind the db surface the live feed reads, and a real
 * WebSocketServer, ChangeDetector and Broadcaster wired over it the way
 * src/http/api_boot/websocket.js wires them, with stub sockets that record
 * every frame sent.
 *
 ********************************************************************/

'use strict';

const sinon           = require('sinon');
const WebSocketServer = require('../../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../../src/ws/broadcaster.js');
const ChangeDetector  = require('../../../../../src/ws/change_detector.js');

// A chain of blocks and actions for one coin. A rollback deletes everything above a
// height, and the next commit reuses the freed action_index range, as the indexer does.
// `hooks.afterMaxAction` runs once, after the next getMaxActionIndex read, so a test can
// roll the chain back between the tip read and the fetch. `reorgVerdict` is what the
// db layer's checkReorgAndInvalidate answers on the next poll (then resets).
function chainDb() {
    const db = {
        blocks: [], actions: [], epoch: 0, hooks: {}, reorgVerdict: false,
        tipBlock()  { return db.blocks.length ? db.blocks[db.blocks.length - 1].block_index : 0; },
        tipAction() { return db.actions.length ? db.actions[db.actions.length - 1].action_index : 0n; },
        commit(count, perBlock) {
            for (let b = 0; b < count; b++) {
                const height = db.tipBlock() + 1;
                db.blocks.push({ block_index: height, block_hash: 'h' + height + 'e' + db.epoch, block_time: 1 });
                let index = db.tipAction();
                for (let i = 0; i < perBlock; i++) {
                    index += 1n;
                    db.actions.push({ action_index: index, block_index: height, action: 'SEND',
                        tx_hash: 't' + index + 'e' + db.epoch, source: 'X', destinations: [] });
                }
            }
        },
        rollbackTo(height) {
            db.blocks  = db.blocks.filter((b) => b.block_index <= height);
            db.actions = db.actions.filter((a) => a.block_index <= height);
        },
        async checkReorgAndInvalidate() { const v = db.reorgVerdict; db.reorgVerdict = false; return v; },
        async getMaxBlockIndex() { return db.tipBlock(); },
        async getMaxActionIndex() {
            const tip = db.tipAction();
            const hook = db.hooks.afterMaxAction;
            if (hook) { delete db.hooks.afterMaxAction; await hook(); }
            return tip;
        },
        async getBlocksSince(config, since, limit) {
            return db.blocks.filter((b) => b.block_index > Number(since)).slice(0, limit).map((b) => ({
                ...b, action_count: BigInt(db.actions.filter((a) => a.block_index === b.block_index).length)
            }));
        },
        // `hooks.beforeActionsSince` runs once, before the next action fetch (after the
        // block fetch of the same poll).
        getActionsSince: sinon.spy(async (config, since, limit, upTo) => (await beforeActions(db)) || db.actions
            .filter((a) => a.action_index > BigInt(since) && (upTo === undefined || upTo === null || a.action_index <= BigInt(upTo)))
            .slice(0, limit).map((a) => ({ ...a, status: null })))
    };
    return db;
}

async function beforeActions(db) {
    const hook = db.hooks.beforeActionsSince;
    if (hook) { delete db.hooks.beforeActionsSince; await hook(); }
    return null;
}

// The live feed over `db` for coin BTC, unseeded (no poll has run yet).
function feed(db, options) {
    const s = new WebSocketServer(Object.assign({ explorer: { db }, broadcaster: null }, options || {}));
    const detector = new ChangeDetector({ db, channelManager: s.channelManager });
    detector.state.BTC = { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false };
    sinon.stub(detector, 'checkBetLatches').resolves();
    sinon.stub(detector, 'checkXcallPhases').resolves();
    s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: detector, maxBackpressure: 4096 });
    return { s, detector };
}

// A connected client on BTC whose socket records every frame.
function connect(s, id) {
    const client = {
        id, coin: 'BTC', chain: 'BTC', network: 'mainnet', ip: '127.0.0.1',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy(), close: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false,
        msgCount: 0, msgLastRefill: Date.now(), lastActivity: Date.now()
    };
    s.clients.set(id, client);
    return client;
}

const sent = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));
const frames = (client, type) => sent(client).filter((m) => m.type === type);
const actionIndexes = (client) => frames(client, 'NEW_ACTION').map((m) => String(m.data.action_index));
const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };

// Let un-awaited handlers (handleCatchUp, sendWelcome) run to completion.
async function settle() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }

function subscribe(s, client, channels, params, id) {
    s.handleSubscribe(client, { action: 'subscribe', channels, params: params || {}, id });
}

module.exports = { chainDb, feed, connect, sent, frames, actionIndexes, range, settle, subscribe };
