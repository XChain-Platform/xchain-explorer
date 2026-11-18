/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * The tracker answers /info with figures whatever its sync state and attaches its
 * own verdict as `sync`. An address read must not present the figures of a tracker
 * that is behind its node or halted as a reading: getAddress answers it as
 * unavailable, the same way it answers an unreachable tracker.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const addresses = require('../../../../../src/db/readers/entities/addresses.js');

const FIGURES = {
    type: 'p2wpkh',
    balances: { confirmed: '0.00000000', pending: '0.00000000', received: '0.00000000' },
    utxos: { confirmed: 0, pending: 0 },
};

function makeReader(info) {
    const reader = Object.create(addresses);
    reader.getAddressTrackerInfo = async () => info;
    reader.getCoinPriceUsd = async () => null;
    reader.getAddressControllerBindings = async () => [];
    reader.getCompactableAddressId = async () => null;
    return reader;
}

const read = async (info) => (await makeReader(info).getAddress({ coin: 'RBTC', data: { search: 'bcrt1qsync' } }))[0];

describe('getAddress reports a tracker that is not synced as unavailable', function () {
    afterEach(() => sinon.restore());

    it('a synced tracker keeps its figures and mempool_ready', async function () {
        const data = await read({ ...FIGURES, mempool_ready: true, sync: { synced: true, lag: 0, mempool_ready: true } });
        expect(data.tracker_available).to.equal(true);
        expect(data.balances.confirmed).to.equal('0.00000000');
        expect(data.mempool_ready).to.equal(true);
    });

    it('a tracker behind its node is unavailable with null figures', async function () {
        const data = await read({ ...FIGURES, mempool_ready: false, sync: { synced: false, lag: 40, mempool_ready: false } });
        expect(data.tracker_available).to.equal(false);
        expect(data.balances).to.deep.equal({ confirmed: null, pending: null, received: null });
        expect(data.utxos).to.deep.equal({ confirmed: null, pending: null });
        expect(data.estimated_value).to.deep.equal({ btc: null, usd: null });
        expect(data).to.not.have.property('mempool_ready');
    });

    it('a halted tracker is unavailable', async function () {
        const data = await read({ ...FIGURES, sync: { synced: false, lag: 0, halted: true, halt_reason: 'reorg' } });
        expect(data.tracker_available).to.equal(false);
        expect(data.balances.confirmed).to.equal(null);
    });

    it('a synced tracker with a reconverging mempool keeps its confirmed figure', async function () {
        const data = await read({ ...FIGURES, mempool_ready: false, sync: { synced: true, lag: 0, mempool_ready: false } });
        expect(data.tracker_available).to.equal(true);
        expect(data.mempool_ready).to.equal(false);
    });

    it('a body from a tracker that sends no sync object keeps its figures', async function () {
        const data = await read({ ...FIGURES });
        expect(data.tracker_available).to.equal(true);
    });
});
