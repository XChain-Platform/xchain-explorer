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
 * Unit tests for src/ws/change_detector/bet_latches.js
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const betLatches = require('../../../../src/ws/change_detector/bet_latches.js');

function makeDetector(feeds) {
    const detector = Object.create(betLatches);
    detector.fetchLimit = 100;
    detector.emit = sinon.spy();
    detector.db = {
        getBetFeedsClosedSince: sinon.spy(async (config, since, limit) =>
            feeds.filter((feed) => Number(feed.closed_block) > since).slice(0, limit))
    };
    return detector;
}

function closedFeed(actionIndex, blockIndex) {
    return {
        action_index: actionIndex,
        closed_block: blockIndex,
        feed_status: 'closed',
        source: '1oracle'
    };
}

describe('bet_latches', function () {
    afterEach(() => sinon.restore());

    it('emits the closed transition when a bet reaches the latched state', async function () {
        const detector = makeDetector([closedFeed(17, 41)]);
        const prev = { closedBlock: 40 };

        await detector.checkBetLatches('BTC', {}, 41, prev);

        expect(detector.emit.calledOnce).to.equal(true);
        expect(detector.emit.firstCall.args[0]).to.equal('lifecycle_event');
        expect(detector.emit.firstCall.args[2]).to.include({ type: 'BET_CLOSED', action: 'BET_CLOSED' });
        expect(detector.emit.firstCall.args[2].data).to.include({ status: 'closed', synthetic: true });
        expect(prev.closedBlock).to.equal(41);
    });

    it('does not re-fire a latch after its cursor has advanced', async function () {
        const detector = makeDetector([closedFeed(17, 41)]);
        const prev = { closedBlock: 40 };

        await detector.checkBetLatches('BTC', {}, 41, prev);
        await detector.checkBetLatches('BTC', {}, 41, prev);

        expect(detector.emit.callCount).to.equal(1);
        expect(detector.db.getBetFeedsClosedSince.secondCall.args[1]).to.equal(41);
    });

    it('starts a missing latch cursor from zero', async function () {
        const detector = makeDetector([]);
        const prev = {};

        await detector.checkBetLatches('BTC', {}, 12, prev);

        expect(detector.db.getBetFeedsClosedSince.firstCall.args[1]).to.equal(0);
        expect(prev.closedBlock).to.equal(12);
    });

    it('uses the last fetched index while a cursor has backlog', function () {
        const detector = Object.create(betLatches);
        detector.fetchLimit = 2;

        const next = detector.nextCursor([{ block_index: 5 }, { block_index: 6 }], 'block_index', 9);

        expect(next).to.equal(6);
    });
});
