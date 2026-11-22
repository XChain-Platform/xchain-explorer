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

const sinon = require('sinon');
const { expect } = require('chai');
const { mk } = require('../change_detector_methods.test/support/helpers.js');

function updates(detector) {
    const events = [];
    detector.on('entity_update', (coin, event) => events.push(event));
    return events;
}

describe('dispenser entity refresh targeting', function () {
    afterEach(() => sinon.restore());

    it('refreshes only the subscribed dispenser touched by a dispense', async function () {
        const detector = mk();
        const events = updates(detector);
        detector.channelManager.getSubscribedDispensers.returns(new Set(['7', '9']));
        detector.db.getDispenseDispenserIndex.resolves(7);
        detector.db.getDispenserInfo.withArgs({}, '7').resolves({ action_index: 7 });

        await detector.emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 20 });

        expect(events.map((event) => event.data.action_index)).to.deep.equal([7]);
        expect(detector.db.getDispenserInfo.calledOnceWith({}, '7')).to.equal(true);
    });

    it('does not refresh an unrelated subscribed dispenser', async function () {
        const detector = mk();
        const events = updates(detector);
        detector.channelManager.getSubscribedDispensers.returns(new Set(['7']));
        detector.db.getDispenseDispenserIndex.resolves(9);

        await detector.emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 20 });

        expect(events).to.deep.equal([]);
        expect(detector.db.getDispenserInfo.called).to.equal(false);
    });

    it('does not refresh for an invalid dispenser mutation', async function () {
        const detector = mk();
        detector.channelManager.getSubscribedDispensers.returns(new Set(['7']));
        detector.db.getValidDispenserMutationIndex.resolves(null);

        await detector.emitEntityUpdates('BTC', {}, { action: 'DISPENSER_CANCEL', action_index: 21 });

        expect(detector.db.getDispenserInfo.called).to.equal(false);
    });

    it('falls back to subscribed dispensers when the targeting lookup fails', async function () {
        const detector = mk();
        const events = updates(detector);
        detector.channelManager.getSubscribedDispensers.returns(new Set(['7', '9']));
        detector.db.getDispenseDispenserIndex.rejects(new Error('lookup failed'));
        detector.db.getDispenserInfo.callsFake(async (config, index) => ({ action_index: Number(index) }));

        await detector.emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 20 });

        expect(events.map((event) => event.data.action_index)).to.deep.equal([7, 9]);
    });
});
