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
const { mk } = require('./helpers.js');

function seedPoll(det, actions) {
    det.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: true };
    det.db.getMaxBlockIndex.resolves(0);
    det.db.getMaxActionIndex.resolves(actions.length);
    det.db.getActionsSince.resolves(actions);
}

// Enrichment reads are cached once per distinct entity per poll, but the
// same per-action events are still emitted.
describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('per-poll entity-read batching', function () {
        it('reads getTokenInfo once per distinct tick per poll but emits one TOKEN_UPDATE per action', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });
            const actions = [
                { action: 'MINT', action_index: 1 },
                { action: 'MINT', action_index: 2 },
                { action: 'MINT', action_index: 3 }
            ];
            seedPoll(det, actions);
            let evs = [];
            det.on('entity_update', (c, e) => { if (e.type === 'TOKEN_UPDATE') evs.push(e); });

            await det.checkCoin('BTC');

            // One DB read for GOLD across the whole poll (was one per action).
            expect(det.db.getTokenInfo.callCount).to.equal(1);
            // But still one TOKEN_UPDATE per action, each carrying its own last_action_index.
            expect(evs.map((e) => e.data.last_action_index)).to.deep.equal([1, 2, 3]);
            expect(evs.every((e) => e.data.tick === 'GOLD' && e.data.supply === '100')).to.equal(true);
        });

        it('reads getAddressBalances once per distinct address per poll but emits one ADDRESS_UPDATE per action', async function () {
            let det = mk();
            det.channelManager.getSubscribedAddresses.returns(new Set(['addrA']));
            det.db.getAddressBalances.resolves([{ tick: 'X', amount: '1' }]);
            const actions = [
                { source: 'addrA', action: 'SEND', action_index: 10 },
                { source: 'addrA', action: 'SEND', action_index: 11 }
            ];
            seedPoll(det, actions);
            let evs = [];
            det.on('entity_update', (c, e) => { if (e.type === 'ADDRESS_UPDATE') evs.push(e); });

            await det.checkCoin('BTC');

            expect(det.db.getAddressBalances.callCount).to.equal(1);
            expect(evs.map((e) => e.data.last_action_index)).to.deep.equal([10, 11]);
            expect(evs.every((e) => e.data.address === 'addrA')).to.equal(true);
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('per-poll entity-read batching', function () {
        it('re-reads an entity on the NEXT poll (cache is per-poll, not persistent)', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });

            det.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: true };
            det.db.getMaxBlockIndex.resolves(0);
            det.db.getMaxActionIndex.onFirstCall().resolves(1).onSecondCall().resolves(2);
            det.db.getActionsSince
                .onFirstCall().resolves([{ action: 'MINT', action_index: 1 }])
                .onSecondCall().resolves([{ action: 'MINT', action_index: 2 }]);

            await det.checkCoin('BTC');
            await det.checkCoin('BTC');

            // One read per poll -> two reads across two polls (no stale cross-poll cache).
            expect(det.db.getTokenInfo.callCount).to.equal(2);
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitAttestationEvents()', function () {
        it('ignores non-ATTEST actions', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitAttestationEvents('BTC', {}, { action: 'SEND' });
            expect(evs).to.deep.equal([]);
        });

        it('emits ATTESTATION_REQUEST for a v0 attest', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.resolves({ version: 0, action_index: 1, request_id: 'r' });
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 });
            expect(evs[0].type).to.equal('ATTESTATION_REQUEST');
        });

        it('emits ATTESTATION_RESPONSE for a v1 attest', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.resolves({ version: 1, action_index: 1 });
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 });
            expect(evs[0].type).to.equal('ATTESTATION_RESPONSE');
        });

        it('is non-fatal on db error and silent when no row is found', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.rejects(new Error('db'));
            await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 }); // no throw

            det.db.getAttestationByActionIndex.resolves(null);
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 2 });
            expect(evs).to.deep.equal([]);
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('getState()', function () {
        it('returns the coin state or a zeroed default', function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 6, initialized: true };
            expect(det.getState('BTC').blockIndex).to.equal(5);
            expect(det.getState('NOPE')).to.deep.equal({ blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0 });
        });
    });
});
