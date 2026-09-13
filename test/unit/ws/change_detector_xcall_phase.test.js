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
 * The XCALL-phase WS channel (spec explorer-coverage-completion row 35, M5.4).
 *
 * WHY THIS CURSOR EXISTS, which is the whole row: a cross-chain call's terminal
 * transition on the SOURCE chain is a direct status write performed by the
 * callback interlock. It mints no action row, so the generic NEW_ACTION path
 * emits nothing when a call completes, and a subscribed page learned that its
 * call had finished only on its next manual fetch. Same shape as the BET
 * deadline latch, which is why this follows _checkBetLatches line for line.
 *
 * What these tests protect:
 *
 *  1. BOTH OUTCOMES RIDE THE SAME CURSOR. A completion is action-less; an
 *     expiry does have an XCALL v2 action. Emitting only completions would give
 *     a live timeline that silently stalls on every call that timed out.
 *  2. THE ROUTING KEY. The Broadcaster routes this channel on data.call_id;
 *     without it the event falls back to a bare channel with no subscribers,
 *     which is the exact failure the bet_feed channel shipped with once.
 *  3. FIRST POLL SEEDS, NEVER REPLAYS. Pushing historical resolutions on
 *     startup tells every subscriber that old calls are finishing right now.
 *  4. A REORG REWINDS THE CURSOR. rollback clears resolved_block, so a call
 *     that re-resolves on the new chain gets a fresh stamp; without the rewind
 *     that second resolution sits below the high-water mark and is never sent.
 *  5. A CAPPED FETCH STOPS ON A BLOCK BOUNDARY. The cursor is a block height,
 *     not a row id, so resuming mid-block would re-emit calls already sent.
 *  6. A MISSING TABLE IS PARKED, NOT RE-DISCOVERED EVERY POLL.
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const ChangeDetector = require('../../../src/ws/ChangeDetector.js');
const ChannelManager = require('../../../src/ws/ChannelManager.js');

const CALL_A = 'a'.repeat(64);
const CALL_B = 'b'.repeat(64);

function createMockDb(opts) {
    opts = opts || {};
    return {
        getMaxBlockIndex:  sinon.stub().resolves(opts.blockIndex || 0),
        getMaxActionIndex: sinon.stub().resolves(opts.actionIndex || 0),
        getBlocksSince:    sinon.stub().resolves([]),
        getActionsSince:   sinon.stub().resolves([])
    };
}

// Stands in for the real SQL: resolved_block > since, ASC, capped at limit.
function withPhases(db, calls) {
    db.getXcallPhasesSince = sinon.spy(async (config, since, limit) =>
        calls.filter((c) => Number(c.resolved_block) > Number(since))
             .sort((a, b) => (a.resolved_block - b.resolved_block) || (a.action_index - b.action_index))
             .slice(0, limit));
    return db;
}

function call(action_index, resolved_block, extra) {
    return Object.assign({
        action_index, resolved_block, call_id: CALL_A, version: 0,
        contract_index: 73, target_chain: 'LTC', target_contract_index: 12,
        method: 'ping', request_status: 'completed', result_status: 'ok',
        callback_action_index: action_index + 1, deadline_block: resolved_block + 100,
        source: 'mSourceAddr', status: 'valid'
    }, extra || {});
}

function detector(db, over) {
    return new ChangeDetector(Object.assign({ db, pollInterval: 60000 }, over || {}));
}

function seed(cd, coin, state) {
    cd.state[coin] = Object.assign(
        { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: true }, state);
}

describe('XCALL phase cursor (M5.4)', function () {

    afterEach(() => sinon.restore());

    it('emits XCALL_COMPLETED on the xcall channel, keyed on the call_id', async function () {
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }), [call(4100, 2598)]);
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2597 });

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');

        expect(spy.callCount).to.equal(1);
        const evt = spy.firstCall.args[1];
        expect(evt.type).to.equal('XCALL_COMPLETED');
        expect(evt.channel).to.equal('xcall');
        // The Broadcaster routes on data.call_id; without it the event falls back
        // to a bare channel that has no subscribers.
        expect(evt.data.call_id).to.equal(CALL_A);
        expect(Number(evt.data.block_index)).to.equal(2598);
        expect(evt.data.tx_hash, 'the interlock write has no causing tx').to.equal(null);
        expect(evt.data.synthetic, 'a completion has no action row behind it').to.equal(true);
    });

    it('emits XCALL_EXPIRED for an expiry, on the same cursor', async function () {
        // Not on the actions cursor even though XCALL v2 mints an action: a
        // subscriber narrowing to the phase names must see both outcomes.
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }),
            [call(4200, 2599, { request_status: 'expired', result_status: null, call_id: CALL_B })]);
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2598 });

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');

        const evt = spy.firstCall.args[1];
        expect(evt.type).to.equal('XCALL_EXPIRED');
        expect(evt.data.call_id).to.equal(CALL_B);
        expect(evt.data.result_status, 'an expired call has an ABSENCE of a result').to.equal(null);
        expect(evt.data.synthetic, 'an expiry DOES have an XCALL v2 action behind it').to.equal(false);
    });

    it('never reports a result_status on an expiry, even if the row carries one', async function () {
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }),
            [call(4300, 2599, { request_status: 'expired', result_status: 'ok' })]);
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2598 });

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');
        expect(spy.firstCall.args[1].data.result_status).to.equal(null);
    });

    it('seeds on the first poll and replays nothing', async function () {
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }), [call(4100, 2400)]);
        const cd = detector(db);
        cd.state['RDOGE'] = { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false };

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');

        expect(spy.callCount).to.equal(0);
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2600);
    });

    it('advances the cursor over an empty span so it is not re-scanned every poll', async function () {
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }), []);
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2500 });
        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2600);
    });

    it('rewinds the cursor on a reorg so a re-resolution is still pushed', async function () {
        // rollback CLEARS resolved_block past the reorg point. Without the rewind
        // the re-stamped resolution sits below the high-water mark forever.
        const db = withPhases(createMockDb({ blockIndex: 2500, actionIndex: 400 }), []);
        db.checkReorgAndInvalidate = sinon.stub().resolves(true);
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2598 });
        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallBlock).to.be.at.most(2500);
    });

    it('stops a capped fetch on the last COMPLETE block rather than mid-block', async function () {
        // Emitting a partial tail and advancing past its block silently drops the
        // rest of it. fetchLimit 2 with three calls, two of them in block 2599.
        const calls = [call(1, 2598), call(2, 2599, { call_id: CALL_B }), call(3, 2599)];
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }), calls);
        const cd = detector(db, { fetchLimit: 2 });
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2597 });

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');

        expect(spy.callCount, 'only the complete block 2598 is emitted').to.equal(1);
        expect(Number(spy.firstCall.args[1].data.block_index)).to.equal(2598);
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2598);
    });

    it('moves past a single oversized block rather than looping on it forever', async function () {
        const calls = [call(1, 2599), call(2, 2599, { call_id: CALL_B })];
        const db = withPhases(createMockDb({ blockIndex: 2600, actionIndex: 500 }), calls);
        const cd = detector(db, { fetchLimit: 2 });
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2598 });

        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2599);
    });

    it('parks a coin whose indexer has no xcalls table, and re-arms without replaying', async function () {
        const missing = new Error('DB error');
        missing.cause = { code: 'ER_NO_SUCH_TABLE' };
        const db = createMockDb({ blockIndex: 2600, actionIndex: 500 });
        db.getXcallPhasesSince = sinon.stub().rejects(missing);
        const cd = detector(db, { betLatchRetryMs: 0 });
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2500 });

        const spy = sinon.spy();
        cd.on('lifecycle_event', spy);
        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallUnsupported).to.equal(true);
        expect(spy.callCount).to.equal(0);

        // The table appears (a per-coin indexer upgrade while this process runs):
        // re-seed to the tip and emit nothing.
        withPhases(db, [call(4100, 2400)]);
        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallUnsupported).to.equal(false);
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2600);
        expect(spy.callCount).to.equal(0);
    });

    it('propagates a genuine DB failure rather than swallowing it as a schema gap', async function () {
        const db = createMockDb({ blockIndex: 2600, actionIndex: 500 });
        db.getXcallPhasesSince = sinon.stub().rejects(new Error('connection lost'));
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2500 });

        let threw = false;
        try { await cd._checkCoin('RDOGE'); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
        expect(cd.state['RDOGE'].xcallUnsupported).to.not.equal(true);
    });

    it('is a no-op against a db that has no phase read at all', async function () {
        const db = createMockDb({ blockIndex: 2600, actionIndex: 500 });
        const cd = detector(db);
        seed(cd, 'RDOGE', { blockIndex: 2600, actionIndex: 500, xcallBlock: 2500 });
        await cd._checkCoin('RDOGE');
        expect(cd.state['RDOGE'].xcallBlock).to.equal(2500);
    });
});

describe('xcall subscription channel (M5.4)', function () {

    function manager() { return new ChannelManager({ maxSubscriptions: 25 }); }
    function client() { return { id: 1, coin: 'RDOGE', subscriptions: new Set() }; }

    it('is a real entity channel, so every surface that enumerates them covers it', function () {
        expect(ChannelManager.ENTITY_CHANNELS.has('xcall')).to.equal(true);
        expect(ChannelManager.VALID_CHANNELS.has('xcall')).to.equal(true);
    });

    it('accepts a subscription keyed by call_id', function () {
        const cm = manager();
        const r = cm.subscribe(client(), ['xcall'], { call_id: CALL_A });
        expect(r.success).to.equal(true);
        expect(r.subscribed[0].call_id).to.equal(CALL_A);
    });

    it('normalizes case so an upper-case subscription still receives events', function () {
        // The event side lower-cases its routing key. Two representations of one
        // call would be two subscription identities, one of which gets nothing.
        const cm = manager();
        const c  = client();
        cm.subscribe(c, ['xcall'], { call_id: CALL_A.toUpperCase() });
        expect(cm.hasSubscribers('RDOGE', 'xcall', { call_id: CALL_A })).to.equal(true);
    });

    it('refuses a call_id that is not 64 hex, rather than making a dead subscription', function () {
        const cm = manager();
        const r = cm.subscribe(client(), ['xcall'], { call_id: 'not-a-call-id' });
        expect(r.success).to.equal(false);
        expect(r.error.code).to.equal('INVALID_CHANNEL');
    });

    it('refuses a subscription with no call_id at all', function () {
        const cm = manager();
        const r = cm.subscribe(client(), ['xcall'], {});
        expect(r.success).to.equal(false);
    });

    it('accepts both phase names in the types filter', function () {
        // A single unknown name fails the ENTIRE subscribe with INVALID_TYPE, so a
        // client narrowing to a real event type would get no channel at all.
        const cm = manager();
        const r = cm.subscribe(client(), ['xcall'],
            { call_id: CALL_A, types: ['XCALL_COMPLETED', 'XCALL_EXPIRED'] });
        expect(r.success).to.equal(true);
    });

    it('round-trips the channel key back to its call_id', function () {
        const cm = manager();
        const c  = client();
        cm.subscribe(c, ['xcall'], { call_id: CALL_A });
        const list = cm.listSubscriptions(c);
        expect(list.some((e) => e.channel === 'xcall' && e.call_id === CALL_A)).to.equal(true);
    });
});
