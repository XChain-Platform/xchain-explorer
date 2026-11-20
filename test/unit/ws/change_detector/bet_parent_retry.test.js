// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const ChangeDetector = require('../../../../src/ws/change_detector.js');

describe('BET parent lookup retry', function () {
    it('holds the action cursor until the parent lookup succeeds', async function () {
        const parent = sinon.stub();
        parent.onFirstCall().rejects(new Error('temporary'));
        parent.onSecondCall().resolves(7);
        const detector = pollingDetector({ action: 'BET', action_index: 501n, action_format: 2, block_index: 10 },
            { getBetActionFeedIndex: parent });

        let failure;
        try { await detector.checkCoin('BTC'); } catch (err) { failure = err; }
        expect(failure).to.have.property('message', 'temporary');
        expect(detector.state.BTC.actionIndex).to.equal(500n);
        expect(detector.emit.called).to.equal(false);

        await detector.checkCoin('BTC');
        expect(detector.state.BTC.actionIndex).to.equal(501n);
        expect(parent.calledTwice).to.equal(true);
        expect(detector.emit.withArgs('action').calledOnce).to.equal(true);
        const lifecycleCall = detector.emit.getCalls().find((call) => call.args[0] === 'lifecycle_event');
        expect(lifecycleCall.args[2].data.feed_action_index).to.equal(7);
    });

    it('holds a BET_EDIT until its valid-edit lookup succeeds, then sends it keyed once', async function () {
        const edit = sinon.stub();
        edit.onFirstCall().rejects(new Error('temporary'));
        edit.onSecondCall().resolves(7);
        const detector = pollingDetector({ action: 'BET_EDIT', action_index: 501n, action_format: 0, block_index: 10 },
            { getValidBetEditFeedIndex: edit });

        let failure;
        try { await detector.checkCoin('BTC'); } catch (err) { failure = err; }
        expect(failure).to.have.property('message', 'temporary');
        expect(detector.state.BTC.actionIndex).to.equal(500n);
        expect(detector.emit.called).to.equal(false);

        await detector.checkCoin('BTC');
        expect(detector.state.BTC.actionIndex).to.equal(501n);
        expect(edit.calledTwice).to.equal(true);
        expect(detector.emit.withArgs('action').calledOnce).to.equal(true);
        const lifecycleCalls = detector.emit.getCalls().filter((call) => call.args[0] === 'lifecycle_event');
        expect(lifecycleCalls).to.have.lengthOf(1);
        expect(lifecycleCalls[0].args[2].data.feed_action_index).to.equal(7);
        expect(lifecycleCalls[0].args[2].channel).to.equal('bet_feed');
    });
});

// A BTC detector one row behind its tip, with that row and the given parent readers.
function pollingDetector(row, readers) {
    const detector = new ChangeDetector({ db: null, fetchLimit: 100 });
    detector.fetchLimit = 100;
    detector.state = { BTC: {
        initialized: true, blockIndex: 10, actionIndex: 500n,
        closedBlock: 10, xcallBlock: 10, liveActionMark: 500n
    } };
    detector.db = {
        checkReorgAndInvalidate: sinon.stub().resolves(false),
        getMaxBlockIndex: sinon.stub().resolves(10),
        getMaxActionIndex: sinon.stub().resolves(501n),
        getActionsSince: sinon.stub().resolves([row]),
        ...readers
    };
    sinon.spy(detector, 'emit');
    detector.emitEntityUpdates = sinon.stub().resolves();
    detector.emitAttestationEvents = sinon.stub().resolves();
    detector.checkBetLatches = sinon.stub().resolves();
    detector.checkXcallPhases = sinon.stub().resolves();
    return detector;
}
