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
 * Unit tests for ChangeDetector (src/ws/ChangeDetector.js)
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const ChangeDetector = require('../../../src/ws/ChangeDetector.js');

// Helper: create a mock db object
function createMockDb(opts) {
    opts = opts || {};
    return {
        getMaxBlockIndex:       sinon.stub().resolves(opts.blockIndex || 0),
        getMaxActionIndex:      sinon.stub().resolves(opts.actionIndex || 0),
        getBlocksSince:         sinon.stub().resolves(opts.blocks || []),
        getActionsSince:        sinon.stub().resolves(opts.actions || []),
        getOrderMatchSettlement: sinon.stub().resolves(opts.settlement || null),
        getCoinpayObligation:   sinon.stub().resolves(opts.obligation || null)
    };
}

describe('ChangeDetector', function () {

    let clock;

    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
    });

    // -----------------------------------------------------------------
    // Initialization and seeding
    // -----------------------------------------------------------------

    describe('initialization', function () {

        it('seeds state on first poll without emitting events', async function () {
            const db = createMockDb({ blockIndex: 100, actionIndex: 500 });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            const blockSpy  = sinon.spy();
            const actionSpy = sinon.spy();
            cd.on('block', blockSpy);
            cd.on('action', actionSpy);

            // Manually call _checkCoin to simulate first poll
            cd.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: false };
            await cd._checkCoin('BTC');

            expect(blockSpy.callCount).to.equal(0);
            expect(actionSpy.callCount).to.equal(0);
            expect(cd.state['BTC'].blockIndex).to.equal(100);
            expect(cd.state['BTC'].actionIndex).to.equal(500);
            expect(cd.state['BTC'].initialized).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Block detection
    // -----------------------------------------------------------------

    describe('block detection', function () {

        it('emits block event when new block detected', async function () {
            const newBlock = { block_index: 101, block_hash: 'abc', block_time: 1234, tx_count: 5, action_count: 2 };
            const db = createMockDb({ blockIndex: 101, blocks: [newBlock] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 0, initialized: true };

            const blockSpy = sinon.spy();
            cd.on('block', blockSpy);

            await cd._checkCoin('BTC');

            expect(blockSpy.calledOnce).to.be.true;
            expect(blockSpy.firstCall.args[0]).to.equal('BTC');
            expect(blockSpy.firstCall.args[1]).to.deep.equal(newBlock);
            expect(cd.state['BTC'].blockIndex).to.equal(101);
        });

        it('does not emit when block index unchanged', async function () {
            const db = createMockDb({ blockIndex: 100 });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 0, initialized: true };

            const blockSpy = sinon.spy();
            cd.on('block', blockSpy);

            await cd._checkCoin('BTC');

            expect(blockSpy.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Action detection
    // -----------------------------------------------------------------

    describe('action detection', function () {

        it('emits action event when new actions detected', async function () {
            const newAction = { action_index: 501, action: 'SEND', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [newAction] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const actionSpy = sinon.spy();
            cd.on('action', actionSpy);

            await cd._checkCoin('BTC');

            expect(actionSpy.calledOnce).to.be.true;
            expect(actionSpy.firstCall.args[1].action).to.equal('SEND');
        });

        it('emits multiple action events for multiple new actions', async function () {
            const actions = [
                { action_index: 501, action: 'SEND' },
                { action_index: 502, action: 'ISSUE' }
            ];
            const db = createMockDb({ blockIndex: 100, actionIndex: 502, actions });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const actionSpy = sinon.spy();
            cd.on('action', actionSpy);

            await cd._checkCoin('BTC');

            expect(actionSpy.callCount).to.equal(2);
        });
    });

    // -----------------------------------------------------------------
    // Lifecycle events
    // -----------------------------------------------------------------

    describe('lifecycle events', function () {

        it('emits ORDER_MATCH lifecycle event', async function () {
            const action = { action_index: 501, action: 'ORDER_MATCH', source: '1abc', status: 'valid' };
            const settlement = { action_index: 501, settlement_type: 'instant' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action], settlement });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            expect(lifecycleSpy.calledOnce).to.be.true;
            expect(lifecycleSpy.firstCall.args[1].type).to.equal('ORDER_MATCH');
        });

        it('emits COINPAY_REQUIRED for coinpay settlement', async function () {
            const action = { action_index: 501, action: 'ORDER_MATCH', source: '1abc', status: 'pending_coinpay' };
            const settlement = { action_index: 501, settlement_type: 'coinpay' };
            const obligation = {
                obligation_action_index: 501,
                order_match_action_index: 501,
                payer_address: '1buyer',
                payee_address: '1seller',
                coin_amount: '0.01000000',
                expiration: 1234567890
            };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action], settlement, obligation });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            // Should emit both ORDER_MATCH and COINPAY_REQUIRED
            expect(lifecycleSpy.callCount).to.equal(2);
            const types = lifecycleSpy.getCalls().map(c => c.args[1].type);
            expect(types).to.include('ORDER_MATCH');
            expect(types).to.include('COINPAY_REQUIRED');
        });

        it('emits COINPAY_FULFILLED for COINPAY action', async function () {
            const action = { action_index: 501, action: 'COINPAY', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            expect(lifecycleSpy.calledOnce).to.be.true;
            expect(lifecycleSpy.firstCall.args[1].type).to.equal('COINPAY_FULFILLED');
        });

        it('emits SWAP_MATCH for SWAP_MATCH action', async function () {
            const action = { action_index: 501, action: 'SWAP_MATCH', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            expect(lifecycleSpy.calledOnce).to.be.true;
            expect(lifecycleSpy.firstCall.args[1].type).to.equal('SWAP_MATCH');
        });

        it('emits DISPENSE for DISPENSE action', async function () {
            const action = { action_index: 501, action: 'DISPENSE', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            expect(lifecycleSpy.calledOnce).to.be.true;
            expect(lifecycleSpy.firstCall.args[1].type).to.equal('DISPENSE');
        });

        it('does not emit lifecycle for SEND action', async function () {
            const action = { action_index: 501, action: 'SEND', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd._checkCoin('BTC');

            expect(lifecycleSpy.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Error resilience
    // -----------------------------------------------------------------

    describe('error resilience', function () {

        it('continues polling when DB query fails', async function () {
            const db = createMockDb();
            db.getMaxBlockIndex.rejects(new Error('DB down'));
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            // _poll catches per-coin errors; should not throw
            await cd._poll();
        });
    });

    // -----------------------------------------------------------------
    // BET deadline latch cursor (, spec §11.1)
    // -----------------------------------------------------------------

    describe('bet latch cursor', function () {

        // Feeds the fake getBetFeedsClosedSince hands back, filtered by the cursor
        // exactly as the real SQL does (closed_block > since, ASC, capped).
        function withLatches(db, feeds) {
            db.getBetFeedsClosedSince = sinon.spy(async (config, since, limit) =>
                feeds.filter((f) => Number(f.closed_block) > Number(since))
                     .sort((a, b) => (a.closed_block - b.closed_block) || (a.action_index - b.action_index))
                     .slice(0, limit));
            return db;
        }

        function feed(action_index, closed_block, extra) {
            return Object.assign({ action_index, closed_block, source: '1oracle',
                                   tick: 'BWS', feed_status: 'closed' }, extra || {});
        }

        it('emits BET_CLOSED on the bet_feed channel, keyed on the feed itself', async function () {
            const db = withLatches(createMockDb({ blockIndex: 120, actionIndex: 500 }), [feed(77, 118)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 120, actionIndex: 500, closedBlock: 117, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd._checkCoin('BTC');

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
            await cd._checkCoin('BTC');

            expect(spy.firstCall.args[1].data.status).to.equal('closed');
            expect(spy.firstCall.args[1].data.feed_status).to.equal('resolved');
        });

        it('does not re-emit a latch it has already pushed', async function () {
            const db = withLatches(createMockDb({ blockIndex: 120, actionIndex: 500 }), [feed(77, 118)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 120, actionIndex: 500, closedBlock: 117, initialized: true };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd._checkCoin('BTC');
            await cd._checkCoin('BTC');

            expect(spy.callCount, 'one latch, one event').to.equal(1);
            expect(cd.state['BTC'].closedBlock).to.equal(120);
        });

        it('seeds the cursor to the tip on the first poll instead of replaying history', async function () {
            const db = withLatches(createMockDb({ blockIndex: 500, actionIndex: 900 }), [feed(1, 12), feed(2, 300)]);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 0, actionIndex: 0, closedBlock: 0, initialized: false };

            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd._checkCoin('BTC');

            expect(spy.callCount, 'old markets must not appear to be closing right now').to.equal(0);
            expect(cd.state['BTC'].closedBlock).to.equal(500);
        });

        it('advances past an empty span so it is not re-scanned every poll', async function () {
            const db = withLatches(createMockDb({ blockIndex: 400, actionIndex: 500 }), []);
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 400, actionIndex: 500, closedBlock: 100, initialized: true };

            await cd._checkCoin('BTC');
            expect(cd.state['BTC'].closedBlock).to.equal(400);
            await cd._checkCoin('BTC');
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
            await cd._checkCoin('BTC');

            expect(spy.getCalls().map((c) => Number(c.args[1].data.action_index)),
                'only the complete block goes out').to.deep.equal([10]);
            expect(cd.state['BTC'].closedBlock).to.equal(10);

            await cd._checkCoin('BTC');
            expect(spy.getCalls().map((c) => Number(c.args[1].data.action_index)),
                'the deferred block drains next poll, once each').to.deep.equal([10, 20, 30, 31]);
        });

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
            await cd._checkCoin('BTC');

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
            await cd._checkCoin('BTC');
            expect(spy.callCount).to.equal(1);
            expect(cd.state['BTC'].closedBlock).to.equal(205);

            // Reorg back to 203. The rollback reset clears the stamp, so the row stops
            // matching the query entirely until the feed latches again.
            feeds.length = 0;
            db.checkReorgAndInvalidate.resolves(true);
            db.getMaxBlockIndex.resolves(203);
            await cd._checkCoin('BTC');
            expect(cd.state['BTC'].closedBlock, 'cursor clamped to the new tip').to.equal(203);

            // Re-latched at 204 on the replacement chain.
            feeds.push(feed(77, 204));
            db.checkReorgAndInvalidate.resolves(false);
            db.getMaxBlockIndex.resolves(206);
            await cd._checkCoin('BTC');
            expect(spy.callCount, 'the re-latch is pushed too').to.equal(2);
        });

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

            await cd._checkCoin('BTC');
            await cd._checkCoin('BTC');
            await cd._checkCoin('BTC');

            expect(db.getBetFeedsClosedSince.callCount, 'asked once, then stopped asking').to.equal(1);
            expect(cd.state['BTC'].betLatchUnsupported).to.equal(true);
        });

        it('re-probes after the cooldown and re-arms when the table appears', async function () {
            // The park is a deploy-order fact, not a property of the chain: this process
            // outlives the upgrade that adds bet_feeds to a coin's indexer. Observed on the
            // devhost fleet, where DOGE was parked at explorer start, its indexer was
            // later rebuilt with P4's migrations, and the coin stayed dark with no way back
            // short of restarting the explorer.
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const sqlErr = new Error("Table 'X.bet_feeds' doesn't exist");
            sqlErr.code = 'ER_NO_SUCH_TABLE'; sqlErr.errno = 1146; sqlErr.sqlState = '42S02';
            const err = new Error('SQL query failed: ...');
            err.name = 'DbQueryError'; err.code = 'DB_ERROR'; err.cause = sqlErr;
            db.getBetFeedsClosedSince = sinon.stub().rejects(err);
            // retryMs 0 so the test drives the cooldown rather than waiting on a clock.
            const cd = new ChangeDetector({ db, pollInterval: 60000, betLatchRetryMs: 0 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            await cd._checkCoin('BTC');
            expect(cd.state['BTC'].betLatchUnsupported, 'parked on the missing table').to.equal(true);

            // That chain's indexer gains the tables. No restart, no reconnect.
            db.getBetFeedsClosedSince = sinon.stub().resolves([]);
            db.getMaxBlockIndex.resolves(121);
            const spy = sinon.spy();
            cd.on('lifecycle_event', spy);
            await cd._checkCoin('BTC');

            expect(cd.state['BTC'].betLatchUnsupported, 're-armed without a restart').to.equal(false);
            expect(cd.state['BTC'].closedBlock, 're-seeded to the tip, not replayed from 0').to.equal(121);
            expect(spy.callCount, 'a re-arm pushes no backlog of historical latches').to.equal(0);
        });

        it('stays parked inside the cooldown, so re-probing is not a per-poll query', async function () {
            const db = createMockDb({ blockIndex: 120, actionIndex: 500 });
            const sqlErr = new Error("Table 'X.bet_feeds' doesn't exist");
            sqlErr.code = 'ER_NO_SUCH_TABLE'; sqlErr.errno = 1146; sqlErr.sqlState = '42S02';
            const err = new Error('SQL query failed: ...');
            err.name = 'DbQueryError'; err.code = 'DB_ERROR'; err.cause = sqlErr;
            db.getBetFeedsClosedSince = sinon.stub().rejects(err);
            const cd = new ChangeDetector({ db, pollInterval: 60000, betLatchRetryMs: 60000 });
            cd.state['BTC'] = { blockIndex: 119, actionIndex: 500, closedBlock: 0, initialized: true };

            await cd._checkCoin('BTC');
            await cd._checkCoin('BTC');
            await cd._checkCoin('BTC');
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
            try { await cd._checkCoin('BTC'); } catch (e) { threw = true; }
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
            await cd._checkCoin('BTC');
            expect(spy.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Start / Stop
    // -----------------------------------------------------------------

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
});
