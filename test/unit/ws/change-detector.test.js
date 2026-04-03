/**
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

            // _poll catches per-coin errors — should not throw
            await cd._poll();
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
