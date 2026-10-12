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
 * The key set of a BET-family websocket frame.
 *
 * The published websocket contract documents exactly the keys emitted here,
 * so a key added to or dropped from a bet_feed lifecycle event has to move
 * the documentation with it. The seven data keys are the base five every
 * lifecycle event carries plus feed_action_index (the routing key) and
 * action_format (the create/cancel/bet/resolve discriminator).
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const ChangeDetector = require('../../../src/ws/change_detector.js');

const FRAME_KEYS = ['type', 'action', 'channel', 'data'];
const DATA_KEYS  = [
    'action_index', 'tx_hash', 'block_index', 'source', 'status',
    'feed_action_index', 'action_format'
];

function collect(db, action) {
    const detector = new ChangeDetector({ db });
    const frames = [];
    detector.on('lifecycle_event', (coin, ev) => frames.push(ev));
    return detector.emitLifecycleEvents('xcp', {}, action).then(() => frames);
}

describe('BET websocket frame keys', () => {
    const action = {
        action: 'BET', action_index: 90, tx_hash: 'ab', block_index: 7,
        source: 'addr', status: 'valid', action_format: 2
    };

    it('emits exactly the seven documented data keys on a BET', async () => {
        const db = { getBetActionFeedIndex: sinon.stub().resolves(41) };
        const frames = await collect(db, action);
        expect(frames).to.have.length.greaterThan(0);
        for (const f of frames) {
            expect(Object.keys(f).sort()).to.deep.equal(FRAME_KEYS.slice().sort());
            expect(f.channel).to.equal('bet_feed');
            expect(Object.keys(f.data).sort()).to.deep.equal(DATA_KEYS.slice().sort());
            expect(f.data.feed_action_index).to.equal(41);
            expect(f.data.action_format).to.equal(2);
        }
    });

    it('keeps all seven keys when the parent lookup fails and the format is absent', async () => {
        const db = { getBetActionFeedIndex: sinon.stub().rejects(new Error('x')) };
        const bare = { action: 'BET_EXPIRE', action_index: 91 };
        const frames = await collect(db, bare);
        expect(frames).to.have.length.greaterThan(0);
        for (const f of frames) {
            expect(Object.keys(f.data).sort()).to.deep.equal(DATA_KEYS.slice().sort());
            expect(f.data.feed_action_index).to.equal(null);
            expect(f.data.action_format).to.equal(null);
        }
    });
});
