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
const ChangeDetector = require('../../../../src/ws/change_detector.js');
const { createMockDb } = require('./helpers.js');

    // The first poll seeds the cursors and emits nothing, because everything at or
    // below the tip already happened: replaying it would tell every subscriber that
    // old blocks and actions are arriving right now.
function registerInitialization() {
    describe('initialization', function () {
        it('seeds state on first poll without emitting events', async function () {
            const db = createMockDb({ blockIndex: 100, actionIndex: 500 });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            const blockSpy  = sinon.spy();
            const actionSpy = sinon.spy();
            cd.on('block', blockSpy);
            cd.on('action', actionSpy);

            // Drive one pass by hand rather than letting the timer run, so the seeding
            // step can be observed on its own.
            cd.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: false };
            await cd.checkCoin('BTC');

            expect(blockSpy.callCount).to.equal(0);
            expect(actionSpy.callCount).to.equal(0);
            expect(cd.state['BTC'].blockIndex).to.equal(100);
            expect(cd.state['BTC'].actionIndex).to.equal(500);
            expect(cd.state['BTC'].initialized).to.be.true;
        });
    });
}

function registerBlockDetection() {
    describe('block detection', function () {
        it('emits block event when new block detected', async function () {
            const newBlock = { block_index: 101, block_hash: 'abc', block_time: 1234, tx_count: 5, action_count: 2 };
            const db = createMockDb({ blockIndex: 101, blocks: [newBlock] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 0, initialized: true };

            const blockSpy = sinon.spy();
            cd.on('block', blockSpy);

            await cd.checkCoin('BTC');

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

            await cd.checkCoin('BTC');

            expect(blockSpy.callCount).to.equal(0);
        });
    });
}

function registerActionDetection() {
    describe('action detection', function () {
        it('emits action event when new actions detected', async function () {
            const newAction = { action_index: 501, action: 'SEND', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [newAction] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const actionSpy = sinon.spy();
            cd.on('action', actionSpy);

            await cd.checkCoin('BTC');

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

            await cd.checkCoin('BTC');

            expect(actionSpy.callCount).to.equal(2);
        });
    });
}

function registerOrderLifecycle() {
    describe('lifecycle events', function () {
        it('emits ORDER_MATCH lifecycle event', async function () {
            const action = { action_index: 501, action: 'ORDER_MATCH', source: '1abc', status: 'valid' };
            const settlement = { action_index: 501, settlement_type: 'instant' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action], settlement });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd.checkCoin('BTC');

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

            await cd.checkCoin('BTC');

            // Two frames, not one: the match itself, then the COINPAY_REQUIRED that
            // tells the paying side it now owes an on-chain payment.
            expect(lifecycleSpy.callCount).to.equal(2);
            const types = lifecycleSpy.getCalls().map(c => c.args[1].type);
            expect(types).to.include('ORDER_MATCH');
            expect(types).to.include('COINPAY_REQUIRED');
        });
    });
}

function registerCoinpayAndSwapLifecycle() {
    describe('lifecycle events', function () {
        it('emits COINPAY_FULFILLED for COINPAY action', async function () {
            const action = { action_index: 501, action: 'COINPAY', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd.checkCoin('BTC');

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

            await cd.checkCoin('BTC');

            expect(lifecycleSpy.calledOnce).to.be.true;
            expect(lifecycleSpy.firstCall.args[1].type).to.equal('SWAP_MATCH');
        });
    });
}

function registerDispenseLifecycle() {
    describe('lifecycle events', function () {
        it('emits DISPENSE for DISPENSE action', async function () {
            const action = { action_index: 501, action: 'DISPENSE', source: '1abc', status: 'valid' };
            const db = createMockDb({ blockIndex: 100, actionIndex: 501, actions: [action] });
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            const lifecycleSpy = sinon.spy();
            cd.on('lifecycle_event', lifecycleSpy);

            await cd.checkCoin('BTC');

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

            await cd.checkCoin('BTC');

            expect(lifecycleSpy.callCount).to.equal(0);
        });
    });
}

function registerErrorResilience() {
    describe('error resilience', function () {
        it('continues polling when DB query fails', async function () {
            const db = createMockDb();
            db.getMaxBlockIndex.rejects(new Error('DB down'));
            const cd = new ChangeDetector({ db, pollInterval: 60000 });
            cd.state['BTC'] = { blockIndex: 100, actionIndex: 500, initialized: true };

            // poll catches per-coin errors; should not throw.
            await cd.poll();
        });
    });
}

module.exports = [
    registerInitialization, registerBlockDetection, registerActionDetection,
    registerOrderLifecycle, registerCoinpayAndSwapLifecycle, registerDispenseLifecycle,
    registerErrorResilience,
];
