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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    actionChannelKeys,
    carriesActions,
    lifecycleChannelKeys
} = require('../../../../src/ws/broadcaster/action_routes.js');

function stubBroadcaster(entityId, addresses) {
    return {
        lifecycleChannelEntityId: () => entityId,
        extractAddresses:         () => addresses
    };
}

describe('broadcaster action routes', () => {

    describe('actionChannelKeys', () => {

        it('starts with actions and orders each distinct party source first', () => {
            const keys = actionChannelKeys('BTC', 'source', [
                'destination-a', 'source', 'destination-b', 'destination-a'
            ]);

            expect(keys).to.deep.equal([
                'BTC:actions',
                'BTC:address:source',
                'BTC:address:destination-a',
                'BTC:address:destination-b'
            ]);
        });

        it('skips falsy parties', () => {
            const keys = actionChannelKeys('XCP', null, [
                '', undefined, false, 0, 'destination'
            ]);

            expect(keys).to.deep.equal(['XCP:actions', 'XCP:address:destination']);
        });

        it('treats non-array destinations as empty', () => {
            expect(actionChannelKeys('XCP', 'source', 'destination')).to.deep.equal([
                'XCP:actions',
                'XCP:address:source'
            ]);
            expect(actionChannelKeys('XCP', null, { address: 'destination' })).to.deep.equal([
                'XCP:actions'
            ]);
        });

    });

    describe('carriesActions', () => {

        it('accepts the coin actions channel', () => {
            expect(carriesActions('BTC', ['BTC:blocks', 'BTC:actions'])).to.equal(true);
        });

        it('accepts any address channel for the coin', () => {
            expect(carriesActions('BTC', ['BTC:address:wallet'])).to.equal(true);
        });

        it('rejects another coin and unrelated channels', () => {
            expect(carriesActions('BTC', [
                'XCP:actions',
                'XCP:address:wallet',
                'BTC:blocks',
                'BTC:market:asset'
            ])).to.equal(false);
        });

    });

    describe('lifecycleChannelKeys', () => {

        it('adds an entity-specific channel and every extracted address', () => {
            const broadcaster = stubBroadcaster('order-7', ['source', 'destination']);
            const keys = lifecycleChannelKeys(broadcaster, 'XCP', {
                channel: 'orders',
                data:    { action: 'update' }
            });

            expect(keys).to.deep.equal([
                'XCP:actions',
                'XCP:orders:order-7',
                'XCP:address:source',
                'XCP:address:destination'
            ]);
        });

        it('uses the bare lifecycle channel when the entity id is falsy', () => {
            const keys = lifecycleChannelKeys(stubBroadcaster(null, []), 'BTC', {
                channel: 'blocks',
                data:    {}
            });

            expect(keys).to.deep.equal(['BTC:actions', 'BTC:blocks']);
        });

        it('adds no lifecycle channel when the event has none', () => {
            const broadcaster = {
                lifecycleChannelEntityId: () => {
                    throw new Error('entity lookup should not run');
                },
                extractAddresses: () => ['wallet']
            };
            const keys = lifecycleChannelKeys(broadcaster, 'BTC', { data: {} });

            expect(keys).to.deep.equal(['BTC:actions', 'BTC:address:wallet']);
        });

    });

});
