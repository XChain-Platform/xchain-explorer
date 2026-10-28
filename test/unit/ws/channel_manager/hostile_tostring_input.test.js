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
 ********************************************************************/

'use strict';

// A JSON value such as {"toString":1} has a non-callable toString, so any
// template literal or String() on it throws "Cannot convert object to primitive
// value". Validation must answer it with a typed refusal, never a throw.

const { expect } = require('chai');
const ChannelManager = require('../../../../src/ws/channel_manager.js');

const HOSTILE = () => JSON.parse('{"toString":1}');
const THROWING = () => ({ toString() { throw new Error('boom'); } });

function newClient() {
    return { id: 'c1', coin: 'RBTC', subscriptions: new Set() };
}

describe('channel manager hostile toString input', function () {
    let manager;
    let client;

    beforeEach(function () {
        manager = new ChannelManager({ maxSubscriptions: 25 });
        client = newClient();
    });

    function expectRefused(result, code) {
        expect(result.success).to.equal(false);
        expect(result.error.code).to.equal(code);
        expect(result.error.message).to.be.a('string');
        expect(client.subscriptions.size).to.equal(0);
        expect(manager.subscriptions.size).to.equal(0);
    }

    for (const [label, make] of [['non-callable toString', HOSTILE], ['throwing toString', THROWING]]) {
        describe(label, function () {
            it('refuses a channel name', function () {
                expectRefused(manager.subscribe(client, [make()], {}), 'INVALID_CHANNEL');
            });

            it('refuses a dispenser action_index', function () {
                expectRefused(manager.subscribe(client, ['dispenser'], { action_index: make() }), 'INVALID_CHANNEL');
            });

            it('refuses an xcall call_id', function () {
                expectRefused(manager.subscribe(client, ['xcall'], { call_id: make() }), 'INVALID_CHANNEL');
            });

            it('refuses an actions type', function () {
                expectRefused(manager.subscribe(client, ['actions'], { types: [make()] }), 'INVALID_TYPE');
            });

            it('answers an unsubscribe with a refusal, not a throw', function () {
                let out;
                expect(() => { out = manager.unsubscribe(client, ['dispenser'], { action_index: make() }); }).to.not.throw();
                expect(out.unsubscribed).to.deep.equal([]);
                expect(out.refused).to.have.length(1);
                expect(out.refused[0].code).to.equal('INVALID_CHANNEL');
            });
        });
    }
});
