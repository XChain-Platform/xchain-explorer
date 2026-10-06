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
 * Unit tests for Broadcaster (src/ws/broadcaster.js): NETWORK_STATS keeps
 * following the tip after a rollback lowers it, while a burst still
 * collapses to one frame for the newest queued block.
 */

'use strict';

const { sinon, expect, createClient, createHarness } = require('../../broadcaster.test.js');

// A harness with one BTC client on the network channel and a stubbed DB read.
function networkHarness(maxActionIndex) {
    const h = createHarness();
    h.client = createClient(1, 'BTC');
    h.wsServer.addClient(h.client);
    h.wsServer.channelManager.subscribe(h.client, ['network']);
    h.getMax = sinon.stub().resolves(maxActionIndex);
    h.wsServer.explorer = { db: { getMaxActionIndex: h.getMax } };
    return h;
}

// Emit one block and wait for its stats frame to settle on the coin's chain.
async function block(h, height) {
    h.changeDetector.emit('block', 'BTC', { block_index: height, action_count: 1 });
    await h.broadcaster._statsTails.get('BTC');
}

// The NETWORK_STATS frames the client received, in order.
function statsFrames(h) {
    return h.client.ws.send.getCalls()
        .map(c => JSON.parse(c.args[0]))
        .filter(m => m.type === 'NETWORK_STATS');
}

describe('Broadcaster', function () {
    describe('NETWORK_STATS after a rollback', function () {

        it('a deep rollback keeps emitting stats for the re-indexed heights', async function () {
            const h = networkHarness(7);
            await block(h, 150);
            await block(h, 101);
            await block(h, 102);
            expect(statsFrames(h).map(m => m.data.block_height)).to.deep.equal(['150', '101', '102']);
        });

        it('a burst after a rollback still collapses to one frame for its newest block', async function () {
            const h = networkHarness(7);
            await block(h, 150);
            h.getMax.resetHistory();
            for (let height = 101; height <= 120; height++)
                h.changeDetector.emit('block', 'BTC', { block_index: height, action_count: 1 });
            await h.broadcaster._statsTails.get('BTC');
            expect(statsFrames(h).map(m => m.data.block_height)).to.deep.equal(['150', '120']);
            expect(h.getMax.callCount).to.equal(1);
        });

        it('a same-height replacement block still emits its own frame', async function () {
            const h = networkHarness(7);
            await block(h, 150);
            await block(h, 150);
            expect(statsFrames(h).map(m => m.data.block_height)).to.deep.equal(['150', '150']);
        });
    });
});
