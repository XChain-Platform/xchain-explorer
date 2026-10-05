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

const { expect } = require('chai');
const channelKeys = require('../../../../src/ws/channel_manager/keys.js');

function expectInvalid(result, message) {
    expect(result).to.be.an('object');
    expect(result.error).to.be.an('object');
    expect(result.error.code).to.equal('INVALID_CHANNEL');
    if (message) expect(result.error.message).to.equal(message);
}

function expectRoundTrip(channel, entityKey, expected = entityKey) {
    const key = channelKeys.buildChannelKey('XCP', channel, entityKey);
    expect(channelKeys.parseChannelKey(key)).to.deep.equal({
        coin: 'XCP',
        channel,
        entityKey: expected
    });
}

describe('channel key building', function () {

    it('builds each supported entity-key shape', function () {
        expect(channelKeys.buildChannelKey('XCP', 'address', { address: '1abc' }))
            .to.equal('XCP:address:1abc');
        expect(channelKeys.buildChannelKey('XCP', 'token', { tick: 'A B' }))
            .to.equal('XCP:token:A%20B');
        expect(channelKeys.buildChannelKey('XCP', 'market', { tick1: 'A B', tick2: 'C/D' }))
            .to.equal('XCP:market:A%20B:C%2FD');
        expect(channelKeys.buildChannelKey('XCP', 'dispenser', { action_index: 0 }))
            .to.equal('XCP:dispenser:0');
        expect(channelKeys.buildChannelKey('XCP', 'xcall', { call_id: 'abc123' }))
            .to.equal('XCP:xcall:abc123');
    });

    it('builds global keys when the entity key is absent or unrecognized', function () {
        expect(channelKeys.buildChannelKey('XCP', 'token')).to.equal('XCP:token');
        expect(channelKeys.buildChannelKey('XCP', 'token', { other: 'unused' })).to.equal('XCP:token');
    });

    it('builds a key from a subscription object', function () {
        const sub = { channel: 'token', tick: 'A B' };
        expect(channelKeys.channelKeyForSub('XCP', sub)).to.equal('XCP:token:A%20B');
    });

});

describe('channel key parsing', function () {

    it('round-trips address, token, and market keys', function () {
        expectRoundTrip('address', { address: 'chain:wallet:7' });
        expectRoundTrip('token', { tick: 'A B' });
        expectRoundTrip('market', { tick1: 'A B', tick2: 'C/D' });
    });

    it('round-trips action indexes and call ids', function () {
        expectRoundTrip('dispenser', { action_index: '0' });
        expectRoundTrip('bet_feed', { action_index: '42' });
        expectRoundTrip('xcall', { call_id: 'abc123' });
    });

    it('parses a two-part key with no entity key', function () {
        expect(channelKeys.parseChannelKey('XCP:blocks')).to.deep.equal({
            coin: 'XCP',
            channel: 'blocks',
            entityKey: null
        });
    });

});

describe('address and token entity-key resolution', function () {

    it('resolves address arrays and singular addresses', function () {
        expect(channelKeys.resolveEntityKeys('address', { addresses: ['a', 'b'] }))
            .to.deep.equal({ keys: [{ address: 'a' }, { address: 'b' }] });
        expect(channelKeys.resolveEntityKeys('address', { address: 'a' }))
            .to.deep.equal({ keys: [{ address: 'a' }] });
    });

    it('refuses address params with neither supported field', function () {
        expectInvalid(
            channelKeys.resolveEntityKeys('address', {}),
            'address channel requires address or addresses param'
        );
    });

    it('resolves token arrays and singular ticks', function () {
        expect(channelKeys.resolveEntityKeys('token', { ticks: ['A', 'B'] }))
            .to.deep.equal({ keys: [{ tick: 'A' }, { tick: 'B' }] });
        expect(channelKeys.resolveEntityKeys('token', { tick: 'A' }))
            .to.deep.equal({ keys: [{ tick: 'A' }] });
    });

    it('refuses token params with neither supported field', function () {
        expectInvalid(
            channelKeys.resolveEntityKeys('token', {}),
            'token channel requires tick or ticks param'
        );
    });

});

describe('market entity-key resolution', function () {

    it('keeps only two-element pairs', function () {
        const pairs = [['A', 'B'], ['short'], 'not-a-pair', ['too', 'many', 'values']];
        expect(channelKeys.resolveEntityKeys('market', { pairs }))
            .to.deep.equal({ keys: [{ tick1: 'A', tick2: 'B' }] });
    });

    it('resolves a singular tick pair', function () {
        expect(channelKeys.resolveEntityKeys('market', { tick1: 'A', tick2: 'B' }))
            .to.deep.equal({ keys: [{ tick1: 'A', tick2: 'B' }] });
    });

    it('refuses market params with neither supported shape', function () {
        expectInvalid(
            channelKeys.resolveEntityKeys('market', {}),
            'market channel requires tick1+tick2 or pairs param'
        );
    });

});

describe('action-index entity-key resolution', function () {

    for (const channel of ['dispenser', 'bet_feed']) {
        it(`resolves index lists and a singular zero for ${channel}`, function () {
            expect(channelKeys.resolveEntityKeys(channel, { action_indexes: [1, '2'] }))
                .to.deep.equal({ keys: [{ action_index: '1' }, { action_index: '2' }] });
            expect(channelKeys.resolveEntityKeys(channel, { action_index: 0 }))
                .to.deep.equal({ keys: [{ action_index: '0' }] });
        });

        it(`refuses noncanonical indexes for ${channel}`, function () {
            for (const value of ['01', '-1', '1.5']) {
                const result = channelKeys.resolveEntityKeys(channel, { action_index: value });
                expectInvalid(
                    result,
                    `${channel} channel action_index must be a canonical decimal integer (got: ${value})`
                );
            }
        });
    }

});

describe('call-id and invalid entity-key resolution', function () {

    it('normalizes a 64-hex call id to lower case', function () {
        const uppercaseId = 'ABCDEF0123456789'.repeat(4);
        expect(channelKeys.resolveEntityKeys('xcall', { call_id: uppercaseId }))
            .to.deep.equal({ keys: [{ call_id: uppercaseId.toLowerCase() }] });
    });

    it('refuses a 63-character call id', function () {
        const shortId = 'a'.repeat(63);
        expectInvalid(
            channelKeys.resolveEntityKeys('xcall', { call_id: shortId }),
            `xcall channel call_id must be a 64-character hex string (got: ${shortId})`
        );
    });

    it('refuses unknown entity channels', function () {
        expectInvalid(
            channelKeys.resolveEntityKeys('mystery', {}),
            'Unknown entity channel: mystery'
        );
    });

    it('refuses an empty resolved address list', function () {
        expectInvalid(
            channelKeys.resolveEntityKeys('address', { addresses: [] }),
            'No entity keys resolved for channel: address'
        );
    });

});
