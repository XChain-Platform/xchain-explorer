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
 * Which ATTEST actions reach the attestation channel, and as what
 *
 * A v0 row is a request and a v1 row a response. Batch rows (v5 head, v6
 * continuation) and unknown versions send nothing there. An expiry (v2) writes
 * no row, so its frame is built from the request it retired, paired the way
 * REST pairs it, and catch-up replay sends the same frames as live.
 *
 * Run: mocha test/unit/ws/change_detector/attestation_events.test.js --timeout 0
 ********************************************************************/

'use strict';

const { EventEmitter } = require('events');
const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../src/ws/broadcaster.js');
const { mk }          = require('../change_detector_methods.test/support/helpers.js');

// The request row the expiry pairing hands back for expiry action 40.
const EXPIRED_REQUEST = { action_index: 5, version: 0, request_id: 'r', provider_id: 'p',
                          contract_index: 7, request_status: 'expired' };

// The attestation-channel events one ATTEST action produces on a fresh detector.
async function attestationEvents(det, action) {
    const evs = [];
    det.on('lifecycle_event', (c, e) => evs.push(e));
    await det.emitAttestationEvents('BTC', { coin: 'BTC' }, action);
    return evs;
}

describe('ChangeDetector attestation events by row version', function () {
    afterEach(() => sinon.restore());

    for (const version of [5, 6, 9]) {
        it('sends nothing for a v' + version + ' attests row', async function () {
            const det = mk();
            det.db.getAttestationByActionIndex.resolves({ version, action_index: 30, request_id: 'batch-key', provider_id: '' });
            expect(await attestationEvents(det, { action: 'ATTEST', action_index: 30, action_format: version })).to.deep.equal([]);
        });
    }

    it('still sends a v0 request and a v1 response with their row fields', async function () {
        const det = mk();
        det.db.getAttestationByActionIndex.onFirstCall().resolves({ version: 0, action_index: 1, request_id: 'r', provider_id: 'p' })
            .onSecondCall().resolves({ version: '1', action_index: 2, request_id: 'r', provider_id: 'p', response_status: 'ok' });
        const evs = [];
        det.on('lifecycle_event', (c, e) => evs.push(e));
        await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1, source: 'S' });
        await det.emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 2 });
        expect(evs.map(e => e.type)).to.deep.equal(['ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE']);
        expect(evs[0].data.source).to.equal('S');
        expect(evs[1].data.response_status).to.equal('ok');
    });
});

describe('ChangeDetector attestation events for an expiry', function () {
    afterEach(() => sinon.restore());

    it('sends ATTESTATION_RESPONSE v2 for the request an expiry retired', async function () {
        const det = mk();
        det.db.seedAttestationFromExpireAction = sinon.stub().resolves(EXPIRED_REQUEST);
        const evs = await attestationEvents(det, { action: 'ATTEST', action_index: 40, action_format: 2, block_index: 12 });
        expect(evs).to.have.lengthOf(1);
        expect(evs[0].type).to.equal('ATTESTATION_RESPONSE');
        expect(evs[0].channel).to.equal('attestation');
        expect(evs[0].data).to.deep.equal({
            action_index: 40, version: 2, request_id: 'r', provider_id: 'p', contract_index: 7,
            request_status: 'expired', response_status: null, block_index: 12, source: null, status: null
        });
        expect(det.db.seedAttestationFromExpireAction.firstCall.args[1]).to.equal(40);
    });

    it('sends nothing for an expiry the pairing cannot resolve or that fails', async function () {
        const det = mk();
        det.db.seedAttestationFromExpireAction = sinon.stub().resolves(null);
        expect(await attestationEvents(det, { action: 'ATTEST', action_index: 40, action_format: 2 })).to.deep.equal([]);
        det.db.seedAttestationFromExpireAction = sinon.stub().rejects(new Error('db'));
        expect(await attestationEvents(det, { action: 'ATTEST', action_index: 41, action_format: 2 })).to.deep.equal([]);
    });

    it('never runs the expiry pairing for a missing row that is not an expiry', async function () {
        const det = mk();
        det.db.seedAttestationFromExpireAction = sinon.stub().resolves(EXPIRED_REQUEST);
        expect(await attestationEvents(det, { action: 'ATTEST', action_index: 42 })).to.deep.equal([]);
        expect(await attestationEvents(det, { action: 'ATTEST', action_index: 43, action_format: 0 })).to.deep.equal([]);
        expect(det.db.seedAttestationFromExpireAction.called).to.equal(false);
    });
});

// A socket client on BTC whose sent frames the test reads back.
function addClient(s) {
    const client = {
        id: 1, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
    s.clients.set(1, client);
    return client;
}

describe('catch-up replay of attestation frames', function () {
    afterEach(() => sinon.restore());

    it('replays an expiry as v2 ATTESTATION_RESPONSE and skips a batch row', async function () {
        const rows = [
            { action_index: 40, action: 'ATTEST', action_format: 2, block_index: 12, destinations: [] },
            { action_index: 41, action: 'ATTEST', action_format: 5, block_index: 12, destinations: [] }
        ];
        const db = {
            getMaxActionIndex: sinon.stub().resolves(41),
            getActionsSince:   sinon.stub().resolves(rows),
            getAttestationByActionIndex: sinon.stub().callsFake(async (config, index) =>
                (index === 41 ? { version: 5, action_index: 41, request_id: 'batch-key', provider_id: '' } : null)),
            seedAttestationFromExpireAction: sinon.stub().resolves(EXPIRED_REQUEST)
        };
        const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
        s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: new EventEmitter() });
        const client = addClient(s);

        await s.handleCatchUp(client, '39', {}, 'r1');

        const sent = client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));
        const attest = sent.filter(m => /^ATTESTATION_/.test(m.type));
        expect(attest.map(m => [m.type, String(m.data.action_index), m.data.version])).to.deep.equal([['ATTESTATION_RESPONSE', '40', 2]]);
        expect(attest[0].catch_up).to.equal(true);
        expect(sent.filter(m => m.type === 'NEW_ACTION').map(m => String(m.data.action_index))).to.deep.equal(['40', '41']);
    });
});
