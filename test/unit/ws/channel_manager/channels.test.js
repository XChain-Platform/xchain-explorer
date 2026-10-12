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
const {
    GLOBAL_CHANNELS,
    ENTITY_CHANNELS,
    ALL_CHANNELS,
    VALID_TYPES
} = require('../../../../src/ws/channel_manager/channels.js');

const EXPECTED_GLOBAL_CHANNELS = ['blocks', 'actions', 'mempool', 'network', 'attestation'];
const EXPECTED_ENTITY_CHANNELS = ['address', 'token', 'market', 'dispenser', 'bet_feed', 'xcall'];
const EXPECTED_VALID_TYPES = [
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST', 'ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE',
    'BATCH', 'BET', 'BET_CLOSED', 'BET_EXPIRE', 'BET_EXPIRED', 'BROADCAST', 'CALLBACK', 'COINPAY',
    'COINPAY_EXPIRE', 'COINPAY_EXPIRED', 'COINPAY_FULFILLED', 'COINPAY_REQUIRED', 'COLLECT',
    'CROSS_SETTLE', 'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSE', 'DISPENSER',
    'DISPENSER_CLOSE', 'DISPENSER_CLOSED', 'DISPENSER_EXPIRE', 'DISPENSER_EXPIRED', 'DIVIDEND',
    'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'LIST_SHARE', 'MESSAGE', 'MINT', 'NODEPROOF',
    'ORDER', 'ORDER_EXPIRE', 'ORDER_EXPIRED', 'ORDER_MATCH', 'PRICE', 'ROLLCALL', 'SEND', 'SLASH',
    'SLEEP', 'STAKE', 'SWAP', 'SWAP_EXPIRE', 'SWAP_EXPIRED', 'SWAP_MATCH', 'SWEEP', 'UNSTAKE',
    'VOTE', 'WITHDRAW', 'XBRIDGE', 'XCALL', 'XCALL_COMPLETED', 'XCALL_EXPIRED', 'XEXEC', 'XPOLICY'
];
const CORE_ACTION_TYPES = ['SEND', 'ORDER', 'SWAP', 'DISPENSER', 'ISSUE', 'STAKE', 'EXECUTE', 'XBRIDGE', 'VOTE'];

describe('channel manager channel and type names', function () {

    it('holds exactly the global channels', function () {
        expect([...GLOBAL_CHANNELS].sort()).to.deep.equal([...EXPECTED_GLOBAL_CHANNELS].sort());
    });

    it('holds exactly the entity channels', function () {
        expect([...ENTITY_CHANNELS].sort()).to.deep.equal([...EXPECTED_ENTITY_CHANNELS].sort());
    });

    it('keeps channel groups disjoint and exposes exactly their union', function () {
        const overlap = [...GLOBAL_CHANNELS].filter((channel) => ENTITY_CHANNELS.has(channel));
        const union = new Set([...GLOBAL_CHANNELS, ...ENTITY_CHANNELS]);

        expect(overlap).to.deep.equal([]);
        expect([...ALL_CHANNELS].sort()).to.deep.equal([...union].sort());
    });

    it('uses unique non-empty upper-case type names made of letters and underscores', function () {
        const values = [...VALID_TYPES];

        expect(VALID_TYPES.size).to.equal(new Set(values).size);
        values.forEach((type) => expect(type).to.be.a('string').and.match(/^[A-Z_]+$/));
    });

    it('holds exactly the valid type names', function () {
        expect([...VALID_TYPES].sort()).to.deep.equal([...EXPECTED_VALID_TYPES].sort());
    });

    it('includes every core action type', function () {
        CORE_ACTION_TYPES.forEach((type) => expect(VALID_TYPES.has(type), type).to.equal(true));
    });

});
