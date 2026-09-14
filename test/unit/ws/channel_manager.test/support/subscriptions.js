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
 * Unit tests for ChannelManager (src/ws/channel_manager.js)
 */

'use strict';

const { expect, ChannelManager, createClient } = require('./helpers.js');

let cm;

function resetChannelManager() {
    cm = new ChannelManager({ maxSubscriptions: 25 });
}
describe('ChannelManager', function () {
    beforeEach(resetChannelManager);

    describe('subscribe – global channels', function () {

        it('subscribes to blocks channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks']);
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(1);
            expect(result.subscribed[0].channel).to.equal('blocks');
            expect(client.subscriptions.size).to.equal(1);
        });

        it('subscribes to multiple global channels', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks', 'actions', 'network']);
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
            expect(client.subscriptions.size).to.equal(3);
        });

        it('rejects invalid channel name', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['invalid_channel']);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects empty channels array', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, []);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects non-array channels', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, 'blocks');
            expect(result.success).to.be.false;
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('subscribe – entity channels', function () {

        it('subscribes to address channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address'], { address: '1abc' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].address).to.equal('1abc');
        });

        it('subscribes to token channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['token'], { tick: 'PEPE' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].tick).to.equal('PEPE');
        });

        it('subscribes to market channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], { tick1: 'PEPE', tick2: 'BTC' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].tick1).to.equal('PEPE');
            expect(result.subscribed[0].tick2).to.equal('BTC');
        });

        it('subscribes to dispenser channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], { action_index: 12345 });
            expect(result.success).to.be.true;
            // action_index is normalized to a canonical decimal STRING at subscription so
            // SUBSCRIBED/SUBSCRIPTION_LIST/UNSUBSCRIBED all agree (v2 BIGINT-as-string).
            expect(result.subscribed[0].action_index).to.equal('12345');
        });

        it('rejects address channel without address param', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address']);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects market channel without both ticks', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], { tick1: 'PEPE' });
            expect(result.success).to.be.false;
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('subscribe – entity channels', function () {
        // A noncanonical index must not become a subscription identity of its own:
        // the snapshot read coerces it back to the real row, so the client would get
        // one dispenser-7 snapshot and then no live frames (Broadcaster routes on the
        // canonical index). The resolver rejects it.
        ['7junk', '007', '7.5', '-1', '', ' 7', '0x7', '1e3'].forEach((bad) => {
            it(`rejects noncanonical dispenser action_index ${JSON.stringify(bad)}`, function () {
                const client = createClient(1);
                const singular = cm.subscribe(client, ['dispenser'], { action_index: bad });
                expect(singular.success, 'singular path').to.be.false;
                expect(singular.error.code).to.equal('INVALID_CHANNEL');
                expect(client.subscriptions.size).to.equal(0);

                const batch = cm.subscribe(client, ['dispenser'], { action_indexes: [bad] });
                expect(batch.success, 'batch path').to.be.false;
                expect(batch.error.code).to.equal('INVALID_CHANNEL');
                expect(client.subscriptions.size).to.equal(0);
            });
        });

        it('rejects a noncanonical entry anywhere in an action_indexes batch (bet_feed too)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['bet_feed'], { action_indexes: [100, '7junk', 300] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
            expect(client.subscriptions.size).to.equal(0);
        });

        it('still accepts canonical indexes as number or string, including 0', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], { action_indexes: [7, '7', 0] });
            expect(result.success).to.be.true;
            // 7 and '7' collapse to the same key, so two distinct entities survive.
            expect(client.subscriptions.size).to.equal(2);
            expect(result.subscribed.map((s) => s.action_index)).to.include('7');
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('subscribe – batch', function () {

        it('subscribes to multiple addresses', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address'], {
                addresses: ['1abc', '1def', '1ghi']
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
            expect(client.subscriptions.size).to.equal(3);
        });

        it('subscribes to multiple market pairs', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], {
                pairs: [['PEPE', 'BTC'], ['XCHAIN', 'BTC']]
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(2);
        });

        it('subscribes to multiple dispensers', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], {
                action_indexes: [100, 200, 300]
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('subscribe – filters', function () {

        it('stores types filter', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { types: ['SEND', 'ORDER_MATCH'] });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.deep.equal(['SEND', 'ORDER_MATCH']);
        });

        it('omits statuses from the subscription list (no-op filter, matching SUBSCRIBED)', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { statuses: ['pending_coinpay'] });
            const subs = cm.listSubscriptions(client);
            // statuses is deliberately not surfaced: the actions feed cannot honor it, so
            // SUBSCRIPTION_LIST must not re-advertise a filter SUBSCRIBED already disowns.
            expect(subs[0].filters.statuses).to.be.undefined;
        });

        it('omits ticks from the subscription list (no-op filter, matching SUBSCRIBED)', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { ticks: ['PEPE'] });
            const subs = cm.listSubscriptions(client);
            // No action frame carries a tick column, so re-advertising the filter here
            // would let a client rely on a stream that never narrows. It is still stored.
            expect(subs[0].filters.ticks).to.be.undefined;
        });

        it('stores once flag', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { once: true });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.once).to.be.true;
        });

        it('rejects invalid types', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['INVALID_TYPE'] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_TYPE');
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('subscribe – filters', function () {
        // A non-iterable `fields` reached `new Set(params.fields)` and threw a
        // synchronous TypeError out of the ws handler (unauthenticated crash).
        it('rejects a non-array fields filter instead of throwing (crash-DoS guard)', function () {
            const client = createClient(1);
            for (const bad of [1, {}, 'abc', true]) {
                const result = cm.subscribe(client, ['blocks'], { fields: bad });
                expect(result.success, 'fields=' + JSON.stringify(bad) + ' must be rejected').to.be.false;
                expect(result.error.code).to.equal('INVALID_PARAMS');
            }
        });

        it('rejects a fields array with non-string members', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks'], { fields: ['ok', 5] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_PARAMS');
        });

        it('accepts a valid string fields array', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks'], { fields: ['height', 'hash'] });
            expect(result.success).to.be.true;
        });

        it('accepts the federation / cross-chain / oracle action types (PRICE, ANCHOR, XCALL, NODEPROOF)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF'] });
            expect(result.success).to.be.true;
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.deep.equal(['PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF']);
        });

        it('still rejects CONTROLLER (a field on ISSUE/ADDRESS, not an action type)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['CONTROLLER'] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_TYPE');
        });

        it('null filters when omitted', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions']);
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.be.null;
            // statuses is not surfaced in the subscription list at all (see above).
            expect(subs[0].filters.statuses).to.be.undefined;
        });
    });
});


