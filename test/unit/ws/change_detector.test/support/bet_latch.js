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
 * Unit tests for ChangeDetector (src/ws/change_detector.js)
 */

'use strict';

const sinon      = require('sinon');

const { expect } = require('chai');
const ChangeDetector = require('../../../../../src/ws/change_detector.js');
const { createMockDb, withLatches, feed } = require('./helpers.js');

    // The deadline latch is the one BET transition with no action row behind it, so it
    // needs a cursor of its own over closed_block (spec §11.1).
function registerBetLatchEvents() {
    describe('bet latch cursor', function () {
        it('emits BET_CLOSED on the bet_feed channel, keyed on the feed itself', async function () {
            const db = withLatches(createMockDb({ blockIndex: 120, actionIndex: 500 }), [feed(77, 118)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 120, actionIndex: 500, closedBlock: 117, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(spy.callCount).to.equal(1);
            const evt = spy.firstCall.args[1];
            expect(evt.type).to.equal('BET_CLOSED');
            expect(evt.channel).to.equal('bet_feed');
            // The Broadcaster routes entity events on feed_action_index; without it the
            // event would fall back to the bare channel, which has no subscribers.
            expect(Number(evt.data.feed_action_index)).to.equal(77);
            expect(Number(evt.data.action_index)).to.equal(77);
            expect(Number(evt.data.block_index)).to.equal(118);
            expect(evt.data.tx_hash, 'the latch has no causing tx').to.equal(null);
            expect(evt.data.synthetic).to.equal(true);
        });

        it('reports the transition, not the status the feed has drifted to by poll time', async function () {
            // The oracle resolved a block later and our poll only sees the row now.
            // Saying `resolved` on a close event would misreport what happened at
            // block_index; the live status rides alongside instead.
            const db = withLatches(createMockDb({ blockIndex: 130, actionIndex: 500 }),
                [feed(9, 125, { feed_status: 'resolved' })]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 130, actionIndex: 500, closedBlock: 124, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(spy.firstCall.args[1].data.status).to.equal('closed');
            expect(spy.firstCall.args[1].data.feed_status).to.equal('resolved');
        });

        it('does not re-emit a latch it has already pushed', async function () {
            const db = withLatches(createMockDb({ blockIndex: 120, actionIndex: 500 }), [feed(77, 118)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 120, actionIndex: 500, closedBlock: 117, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');
            await cd.checkCoin('BTC');

            expect(spy.callCount, 'one latch, one event').to.equal(1);
            expect(cd.state['BTC'].closedBlock).to.equal(120);
        });
    });
}

function registerBetLatchCursor() {
    describe('bet latch cursor', function () {
        it('seeds the cursor to the tip on the first poll instead of replaying history', async function () {
            const db = withLatches(createMockDb({ blockIndex: 500, actionIndex: 900 }), [feed(1, 12), feed(2, 300)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 0, actionIndex: 0, closedBlock: 0, initialized: false };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(spy.callCount, 'old markets must not appear to be closing right now').to.equal(0);
            expect(cd.state['BTC'].closedBlock).to.equal(500);
        });

        it('advances past an empty span so it is not re-scanned every poll', async function () {
            const db = withLatches(createMockDb({ blockIndex: 400, actionIndex: 500 }), []);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 400, actionIndex: 500, closedBlock: 100, initialized: true };

            await cd.checkCoin('BTC');
            expect(cd.state['BTC'].closedBlock).to.equal(400);
            await cd.checkCoin('BTC');
            expect(db.getBetFeedsClosedSince.secondCall.args[1], 'second poll resumes at the tip').to.equal(400);
        });

        it('stops a capped fetch on a whole-block boundary rather than cutting a block in half', async function () {
            // fetchLimit 3 against a block that latched two feeds: resuming mid-block
            // would either re-emit 30 or drop 31, and the cursor is a block height so
            // it cannot express "half of block 11".
            const feeds = [feed(10, 10), feed(20, 11), feed(30, 11), feed(31, 11)];
            const db = withLatches(createMockDb({ blockIndex: 11, actionIndex: 500 }), feeds);
            const cd = new ChangeDetector({ db, pollInterval: 60000, fetchLimit: 3 });
            cd.state['BTC'] = { blockIndex: 11, actionIndex: 500, closedBlock: 9, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(spy.getCalls().map((c) => Number(c.args[1].data.action_index)),
                'only the complete block goes out').to.deep.equal([10]);
            expect(cd.state['BTC'].closedBlock).to.equal(10);

            await cd.checkCoin('BTC');
            expect(spy.getCalls().map((c) => Number(c.args[1].data.action_index)),
                'the deferred block drains next poll, once each').to.deep.equal([10, 20, 30, 31]);
        });
    });
}

function registerBetLatchReorg() {
    describe('bet latch cursor', function () {
        it('does not stall when one block latches more feeds than a fetch holds', async function () {
            // MAX_BET_PASS_ROWS is 5000 against a fetchLimit of 100, so a single block
            // can exceed one fetch with no boundary to stop on. Best-effort push: move
            // past it rather than looping on the same block forever.
            const feeds = [feed(1, 50), feed(2, 50), feed(3, 50)];
            const db = withLatches(createMockDb({ blockIndex: 50, actionIndex: 500 }), feeds);
            const cd = new ChangeDetector({ db, pollInterval: 60000, fetchLimit: 3 });
            cd.state['BTC'] = { blockIndex: 50, actionIndex: 500, closedBlock: 49, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(spy.callCount).to.equal(3);
            expect(cd.state['BTC'].closedBlock).to.equal(50);
        });

        it('rewinds the cursor on a reorg so a re-latched feed is pushed again', async function () {
            // rollback.js clears closed_block past the rollback height, so the feed
            // re-latches on the new chain with a fresh stamp. Without the rewind that
            // second latch sits below the high-water mark and never reaches anyone.
            const feeds = [feed(77, 204)];
            const db = withLatches(createMockDb({ blockIndex: 205, actionIndex: 500 }), feeds);
            db.checkReorgAndInvalidate = sinon.stub().resolves(false);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 205, actionIndex: 500, closedBlock: 203, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');
            expect(spy.callCount).to.equal(1);
            expect(cd.state['BTC'].closedBlock).to.equal(205);

            // Reorg back to 203. The rollback reset clears the stamp, so the row stops
            // matching the query entirely until the feed latches again.
            feeds.length = 0;
            db.checkReorgAndInvalidate.resolves(true);
            db.getMaxBlockIndex.resolves(203);
            await cd.checkCoin('BTC');
            expect(cd.state['BTC'].closedBlock, 'cursor clamped to the new tip').to.equal(203);

            // Re-latched at 204 on the replacement chain.
            feeds.push(feed(77, 204));
            db.checkReorgAndInvalidate.resolves(false);
            db.getMaxBlockIndex.resolves(206);
            await cd.checkCoin('BTC');
            expect(spy.callCount, 'the re-latch is pushed too').to.equal(2);
        });
    });
}

function registerBetLatchSchemaRecovery() {
    describe('bet latch cursor', function () {
        it('disables itself for a coin whose indexer has no bet_feeds table, once', async function () {
            // Found live on the regtest fleet: the LTC indexer DB predated P4's
            // migrations, so the query threw on every 5s poll. The tables are
            // per-coin, so this must silence that coin only and say so once.
            // The error shape is the REAL one: db.js rethrows as DbQueryError with its
            // own code and the driver's SqlError on .cause. A hand-made flat error
            // here is what let the first version of this guard pass a green test and
            // still log the missing table every poll against the live fleet.
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const sqlErr = new Error("Table 'X.bet_feeds' doesn't exist");
            sqlErr.code = 'ER_NO_SUCH_TABLE'; sqlErr.errno = 1146; sqlErr.sqlState = '42S02';
            const err = new Error('SQL query failed: ...');
            err.name = 'DbQueryError'; err.code = 'DB_ERROR'; err.cause = sqlErr;
            db.getBetFeedsClosedSince = sinon.stub().rejects(err);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            await cd.checkCoin('BTC');
            await cd.checkCoin('BTC');
            await cd.checkCoin('BTC');

            expect(db.getBetFeedsClosedSince.callCount, 'asked once, then stopped asking').to.equal(1);
            expect(cd.state['BTC'].betLatchUnsupported).to.equal(true);
        });

        it('re-probes after the cooldown and re-arms when the table appears', async function () {
            // The park is a deploy-order fact, not a property of the chain: this process
            // outlives the upgrade that adds bet_feeds to a coin's indexer, so a coin parked
            // at explorer start must be able to re-arm once its indexer catches up, with no
            // restart and no backlog of historical latches replayed.
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const sqlErr = new Error("Table 'X.bet_feeds' doesn't exist");
            sqlErr.code = 'ER_NO_SUCH_TABLE'; sqlErr.errno = 1146; sqlErr.sqlState = '42S02';
            const err = new Error('SQL query failed: ...');
            err.name = 'DbQueryError'; err.code = 'DB_ERROR'; err.cause = sqlErr;
            db.getBetFeedsClosedSince = sinon.stub().rejects(err);
            // retryMs 0 so the test drives the cooldown rather than waiting on a clock.
            const cd = new ChangeDetector({ db, pollInterval: 60000, betLatchRetryMs: 0 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            await cd.checkCoin('BTC');
            expect(cd.state['BTC'].betLatchUnsupported, 'parked on the missing table').to.equal(true);

            // That chain's indexer gains the tables. No restart, no reconnect.
            db.getBetFeedsClosedSince = sinon.stub().resolves([]);
            db.getMaxBlockIndex.resolves(121);
            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');

            expect(cd.state['BTC'].betLatchUnsupported, 're-armed without a restart').to.equal(false);
            expect(cd.state['BTC'].closedBlock, 're-seeded to the tip, not replayed from 0').to.equal(121);
            expect(spy.callCount, 'a re-arm pushes no backlog of historical latches').to.equal(0);
        });
    });
}

function registerBetLatchFallbacks() {
    describe('bet latch cursor', function () {
        it('stays parked inside the cooldown, so re-probing is not a per-poll query', async function () {
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const sqlErr = new Error("Table 'X.bet_feeds' doesn't exist");
            sqlErr.code = 'ER_NO_SUCH_TABLE'; sqlErr.errno = 1146; sqlErr.sqlState = '42S02';
            const err = new Error('SQL query failed: ...');
            err.name = 'DbQueryError'; err.code = 'DB_ERROR'; err.cause = sqlErr;
            db.getBetFeedsClosedSince = sinon.stub().rejects(err);
            const cd = new ChangeDetector({ db, pollInterval: 60000, betLatchRetryMs: 60000 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            await cd.checkCoin('BTC');
            await cd.checkCoin('BTC');
            await cd.checkCoin('BTC');
            expect(db.getBetFeedsClosedSince.callCount, 'one probe per cooldown, not per poll').to.equal(1);
        });

        it('still surfaces a genuine DB failure instead of silencing the coin', async function () {
            // Only the missing-table case is a schema fact; everything else is a fault
            // the poll loop's own handler should see and log.
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            db.getBetFeedsClosedSince = sinon.stub().rejects(new Error('connection lost'));
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            let threw = false;
            try { await cd.checkCoin('BTC'); } catch (e) { threw = true; }
            expect(threw, 'propagates to the poll loop').to.equal(true);
            expect(cd.state['BTC'].betLatchUnsupported, 'not disabled by a transient fault').to.not.equal(true);
        });

        it('is inert against a db build without the latch query', async function () {
            // The method is newer than the ws layer; an older db.js must degrade to
            // "no latch events" rather than throwing every poll and killing the feed.
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd.checkCoin('BTC');
            expect(spy.callCount).to.equal(0);
        });
    });
}

function registerStartStop() {
    describe('start / stop', function () {
        it('start initializes state for provided coins', function () {
            const db = createMockDb();
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.start(['BTC', 'LTC']);
            expect(cd.state).to.have.property('BTC');
            expect(cd.state).to.have.property('LTC');
            cd.stop();
        });

        it('stop clears timer', function () {
            const db = createMockDb();
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.start(['BTC']);
            expect(cd.timer).to.not.be.null;
            cd.stop();
            expect(cd.timer).to.be.null;
            expect(cd.running).to.be.false;
        });
    });
}

module.exports = [
    registerBetLatchEvents, registerBetLatchCursor, registerBetLatchReorg,
    registerBetLatchSchemaRecovery, registerBetLatchFallbacks, registerStartStop,
];
