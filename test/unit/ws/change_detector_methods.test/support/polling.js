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
 * Unit tests for src/ws/change_detector.js: the indexer-DB poller that turns
 * new blocks/actions into WebSocket events. All collaborators are injected, so
 * no real DB or timers are needed (fake timers used only for the poll loop).
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const { mk, range } = require('./helpers.js');

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('start() / stop()', function () {
        it('seeds per-coin state, polls immediately, and schedules the interval', function () {
            let clock = sinon.useFakeTimers();
            let det = mk();
            let poll = sinon.stub(det, 'poll').resolves();
            det.start(['BTC', 'TBTC']);

            expect(det.running).to.be.true;
            expect(det.state.BTC).to.deep.equal({ blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false });
            expect(poll.calledOnce).to.be.true;            // immediate poll
            clock.tick(5001);
            expect(poll.callCount).to.equal(2);            // interval poll

            det.stop();
            expect(det.running).to.be.false;
            expect(det.timer).to.be.null;
            clock.restore();
        });

        it('is idempotent when already running', function () {
            let det = mk();
            det.running = true;
            let poll = sinon.stub(det, 'poll');
            det.start(['BTC']);
            expect(poll.called).to.be.false;
        });

        it('preserves existing coin state across a restart', function () {
            let clock = sinon.useFakeTimers();
            let det = mk();
            sinon.stub(det, 'poll').resolves();
            det.state.BTC = { blockIndex: 9, actionIndex: 9, initialized: true };
            det.start(['BTC']);
            expect(det.state.BTC.blockIndex).to.equal(9); // not reset
            det.stop();
            clock.restore();
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_poll()', function () {
        it('does nothing when not running', async function () {
            let det = mk();
            det.state = { BTC: {} };
            let check = sinon.stub(det, 'checkCoin');
            await det.poll();
            expect(check.called).to.be.false;
        });

        it('swallows per-coin errors', async function () {
            let det = mk();
            det.running = true;
            det.state = { BTC: {} };
            sinon.stub(det, 'checkCoin').rejects(new Error('boom'));
            await det.poll(); // must not throw
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_checkCoin()', function () {
        it('seeds state on the first poll without emitting', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 0, actionIndex: 0, initialized: false };
            det.db.getMaxBlockIndex.resolves(10);
            det.db.getMaxActionIndex.resolves(20);
            let events = [];
            det.on('block', () => events.push('b'));
            det.on('action', () => events.push('a'));

            await det.checkCoin('BTC');

            expect(det.state.BTC).to.include({ blockIndex: 10, actionIndex: 20, initialized: true });
            expect(events).to.deep.equal([]);
        });

        it('emits block and action events for new data and advances state', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(7);
            det.db.getMaxActionIndex.resolves(8);
            det.db.getBlocksSince.resolves([{ block_index: 6 }, { block_index: 7 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 6 }]);
            let blocks = [], actions = [];
            det.on('block', (c, b) => blocks.push(b));
            det.on('action', (c, a) => actions.push(a));

            await det.checkCoin('BTC');

            expect(blocks).to.have.length(2);
            expect(actions).to.have.length(1);
            expect(det.state.BTC.blockIndex).to.equal(7);
            expect(det.state.BTC.actionIndex).to.equal(8);
        });

        it('does not emit when the max indexes are unchanged', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(5);
            det.db.getMaxActionIndex.resolves(5);
            let count = 0;
            det.on('block', () => count++);
            det.on('action', () => count++);
            await det.checkCoin('BTC');
            expect(count).to.equal(0);
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_checkCoin()', function () {
        // Regression: a burst larger than fetchLimit must not advance the cursor
        // straight to the observed tip after a capped fetch, which would skip for good
        // every action past the first fetchLimit in that interval.
        it('drains an action burst larger than fetchLimit across polls without skipping any', async function () {
            let det = mk();  // fetchLimit 100
            det.state.BTC = { blockIndex: 0, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(0);
            det.db.getMaxActionIndex.resolves(255);   // 250 new actions, > fetchLimit
            det.db.getActionsSince.callsFake(async (cfg, since, limit) => {
                let rows = [];
                for (let i = since + 1; i <= Math.min(since + limit, 255); i++)
                    rows.push({ action: 'SEND', action_index: i });
                return rows;
            });
            let seen = [];
            det.on('action', (c, a) => seen.push(a.action_index));

            await det.checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(105);   // last fetched, NOT the tip 255
            await det.checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(205);
            await det.checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(255);   // fully drained
            expect(seen).to.deep.equal(range(6, 255));          // every action emitted once, none skipped
        });

        // Number() collapsed two consecutive action indices above 2^53 onto one
        // value, so a capped fetch could hand back a cursor at or past an action that
        // was never emitted, and the `last < currentMax` backlog test read equal.
        it('advances a >2^53 action cursor exactly instead of through a collapsed Number', function () {
            let det = mk();  // fetchLimit 100
            let rows = [];
            for (let i = 0n; i < 100n; i++) rows.push({ action: 'SEND', action_index: 9007199254740000n + i });

            let next = det.nextCursor(rows, 'action_index', 9007199254741000n);
            expect(String(next)).to.equal('9007199254740099');
            expect(typeof next).to.equal('bigint');
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_checkCoin()', function () {
        it('leaves the block cursor a Number (only the action cursor went BigInt)', function () {
            let det = mk();  // fetchLimit 100
            let rows = [];
            for (let i = 1; i <= 100; i++) rows.push({ block_index: i });

            let next = det.nextCursor(rows, 'block_index', 500);
            expect(next).to.equal(100);
            expect(typeof next).to.equal('number');
        });

        it('drains a block burst larger than fetchLimit across polls', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 0, actionIndex: 0, initialized: true };
            det.db.getMaxBlockIndex.resolves(150);
            det.db.getBlocksSince.callsFake(async (cfg, since, limit) => {
                let rows = [];
                for (let i = since + 1; i <= Math.min(since + limit, 150); i++) rows.push({ block_index: i });
                return rows;
            });
            let seen = [];
            det.on('block', (c, b) => seen.push(b.block_index));
            await det.checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(100);   // capped at fetchLimit, not tip 150
            await det.checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(150);
            expect(seen).to.deep.equal(range(1, 150));
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_checkCoin()', function () {
        // Regression: the reorg flag was computed but discarded, so a reorg that
        // lowered the tip left the cursor above it and the feed stalled (or skipped
        // the replaced tail) until the chain re-passed the old high-water mark.
        it('rewinds the cursor to the new tip on a reorg that lowers the height', async function () {
            let det = mk();
            det.db.checkReorgAndInvalidate = sinon.stub().resolves(true);
            det.state.BTC = { blockIndex: 100, actionIndex: 100, initialized: true };
            det.db.getMaxBlockIndex.resolves(95);
            det.db.getMaxActionIndex.resolves(95);
            let count = 0;
            det.on('block', () => count++);
            det.on('action', () => count++);

            await det.checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(95);    // clamped down, not stuck at 100
            expect(det.state.BTC.actionIndex).to.equal(95);
            expect(count).to.equal(0);

            // A single new block/action above the new tip now emits immediately,
            // instead of waiting for the chain to climb back above 100.
            det.db.checkReorgAndInvalidate.resolves(false);
            det.db.getMaxBlockIndex.resolves(96);
            det.db.getMaxActionIndex.resolves(96);
            det.db.getBlocksSince.resolves([{ block_index: 96 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 96 }]);
            await det.checkCoin('BTC');
            expect(count).to.equal(2);
        });

        it('does not lower the cursor on a reorg whose new tip is higher', async function () {
            let det = mk();
            det.db.checkReorgAndInvalidate = sinon.stub().resolves(true);
            det.state.BTC = { blockIndex: 10, actionIndex: 10, initialized: true };
            det.db.getMaxBlockIndex.resolves(12);
            det.db.getMaxActionIndex.resolves(12);
            det.db.getBlocksSince.resolves([{ block_index: 11 }, { block_index: 12 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 11 }, { action: 'SEND', action_index: 12 }]);
            let blocks = 0;
            det.on('block', () => blocks++);
            await det.checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(12);
            expect(blocks).to.equal(2);
        });
    });
});
