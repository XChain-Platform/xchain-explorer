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
 * Unit tests for ChannelManager (src/ws/channel_manager.js): a subscribe
 * request is all-or-nothing, so a refused batch leaves the client's
 * subscriptions and stored filters exactly as they were.
 */

'use strict';

const { expect, ChannelManager, createClient } = require('./helpers.js');

// The client's held keys plus the filter object stored under each one.
function holdings(cm, client) {
    const held = [...client.subscriptions].sort();
    return held.map(key => [key, cm.subscriptions.get(key) && cm.subscriptions.get(key).get(client.id)]);
}

describe('ChannelManager', function () {
    describe('a refused subscribe batch saves nothing', function () {

        it('a global channel ahead of an unresolvable entity channel is not saved', function () {
            const cm = new ChannelManager({ maxSubscriptions: 25 });
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks', 'address'], {});
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
            expect(client.subscriptions.size).to.equal(0);
            expect(cm.subscriptions.has(cm.buildChannelKey('BTC', 'blocks', null))).to.be.false;
        });

        it('an address batch that crosses the limit saves none of its addresses', function () {
            const cm = new ChannelManager({ maxSubscriptions: 3 });
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            const before = holdings(cm, client);
            const result = cm.subscribe(client, ['address'], { addresses: ['1abc', '1def', '1ghi'] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('SUBSCRIPTION_LIMIT');
            expect(holdings(cm, client)).to.deep.equal(before);
            expect(cm.subscriptions.has(cm.buildChannelKey('BTC', 'address', { address: '1abc' }))).to.be.false;
        });

        it('a refused batch leaves the filter of a key already held untouched', function () {
            const cm = new ChannelManager({ maxSubscriptions: 2 });
            const client = createClient(1);
            cm.subscribe(client, ['address'], { address: '1abc' });
            const key = cm.buildChannelKey('BTC', 'address', { address: '1abc' });
            const filterBefore = cm.subscriptions.get(key).get(client.id);
            const result = cm.subscribe(client, ['address'], { addresses: ['1abc', '1def', '1ghi'], once: true });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('SUBSCRIPTION_LIMIT');
            expect(cm.subscriptions.get(key).get(client.id)).to.equal(filterBefore);
            expect(client.subscriptions.size).to.equal(1);
        });
    });

    describe('the batch limit counts each new key once', function () {

        it('a batch that exactly fills the limit succeeds', function () {
            const cm = new ChannelManager({ maxSubscriptions: 3 });
            const client = createClient(1);
            const result = cm.subscribe(client, ['address'], { addresses: ['1abc', '1def', '1ghi'] });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.length(3);
            expect(client.subscriptions.size).to.equal(3);
        });

        it('held and repeated keys in one batch do not count against the limit twice', function () {
            const cm = new ChannelManager({ maxSubscriptions: 2 });
            const client = createClient(1);
            cm.subscribe(client, ['address'], { address: '1abc' });
            const result = cm.subscribe(client, ['address'], { addresses: ['1abc', '1def', '1def'] });
            expect(result.success).to.be.true;
            expect(result.subscribed.map(s => s.address)).to.deep.equal(['1abc', '1def', '1def']);
            expect(client.subscriptions.size).to.equal(2);
        });
    });
});
