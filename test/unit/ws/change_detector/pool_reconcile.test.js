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
 * The live feed follows the database pool set, not a boot snapshot
 *
 * The db layer gains pools after boot (hub config sync, the lazy rebuild), and
 * each rebuild REPLACES db.pools with a new object. These tests start the
 * detector with no pools, swap a new pool map in, and check the next poll seeds
 * the new coin at its tip and the poll after that sends its rows live.
 *
 * Run: mocha test/unit/ws/change_detector/pool_reconcile.test.js --timeout 0
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');

const ChangeDetector   = require('../../../../src/ws/change_detector.js');
const { createMockDb } = require('../change_detector.test/support/helpers.js');

// A detector whose timer never fires during a test: each pass is driven by poll().
function detectorOver(db) {
    return new ChangeDetector({ db, pollInterval: 3600000 });
}

describe('ChangeDetector pool reconcile', function () {
    let det;

    afterEach(async function () {
        if (det) await det.stop();
        det = null;
        sinon.restore();
    });

    it('adopts a coin whose pool appears after start and seeds it at its tip', async function () {
        const db = createMockDb({ blockIndex: 50, actionIndex: 500 });
        db.pools = {};
        det = detectorOver(db);
        det.start([]);
        await det.poll();
        expect(det.running).to.equal(true);
        expect(det.state).to.deep.equal({});
        expect(db.getMaxBlockIndex.called).to.equal(false);

        // A rebuild hands the db a brand-new pool map.
        db.pools = { BTC: { pool: {} } };
        const events = [];
        det.on('action', (coin, a) => events.push([coin, a.action_index]));
        await det.poll();
        expect(det.state.BTC.initialized).to.equal(true);
        expect(det.state.BTC.actionIndex).to.equal(500);
        expect(det.mempoolState.BTC).to.be.an('object');
        expect(events).to.deep.equal([]);
    });

    it('sends the adopted coin rows live on the poll after the seed', async function () {
        const db = createMockDb({ blockIndex: 50, actionIndex: 500 });
        db.pools = {};
        det = detectorOver(db);
        det.start([]);
        await det.poll();
        db.pools = { BTC: { pool: {} } };
        await det.poll();

        const events = [];
        det.on('action', (coin, a) => events.push([coin, a.action_index]));
        db.getMaxActionIndex.resolves(501);
        db.getActionsSince.resolves([{ action: 'SEND', action_index: 501, block_index: 50 }]);
        await det.poll();
        expect(events).to.deep.equal([['BTC', 501]]);
    });

    it('keeps a tracked coin cursor when a later pool map no longer names it', async function () {
        const db = createMockDb({ blockIndex: 50, actionIndex: 500 });
        db.pools = { BTC: { pool: {} } };
        det = detectorOver(db);
        det.start(['BTC']);
        await det.poll();
        expect(det.state.BTC.initialized).to.equal(true);

        db.pools = { LTC: { pool: {} } };
        await det.poll();
        expect(det.state.BTC.actionIndex).to.equal(500);
        expect(det.state.LTC.initialized).to.equal(true);
    });

    it('leaves the coin set alone for a db double with no pool map', async function () {
        const db = createMockDb({ blockIndex: 7, actionIndex: 70 });
        det = detectorOver(db);
        det.start(['BTC']);
        await det.poll();
        expect(Object.keys(det.state)).to.deep.equal(['BTC']);
        expect(det.state.BTC.initialized).to.equal(true);
    });
});
