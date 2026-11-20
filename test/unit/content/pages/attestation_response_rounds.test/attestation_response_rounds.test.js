'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});
const configInfo = createConfigInfoStub();
const util = new Utility(configInfo);
const REQUEST_ID = 'a'.repeat(64);
const LIFECYCLE = 'FROM attests m LEFT JOIN actions';

function detailConfig(){
    return makeConfig({ coin: 'BTC', type: 'api', data: { method: 'getAttestation',
        search: REQUEST_ID, type: null,
        sql: { order: 'DESC', limit: 100, where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] } } } });
}

function makeDb(legs){
    const db = new Database({ configInfo, util, hubOperational: null });
    db.doQuery = sinon.stub().callsFake(async (_cfg, query) =>
        String(query).replace(/\s+/g, ' ').includes(LIFECYCLE) ? legs : []);
    return db;
}

function request(status = 'fulfilled'){
    return { action: 'ATTEST', action_index: 500, version: 0, request_id: REQUEST_ID,
        provider_id: 'http_get', request_status: status, responsible_set_json: null,
        callback_params_json: null, origin_chain: null, origin_action_index: null };
}

function round(actionIndex, responseStatus, status = 'valid', callbackIndex = null){
    return { action: 'ATTEST', action_index: actionIndex, version: 1, request_id: REQUEST_ID,
        provider_id: 'http_get', response_status: responseStatus, status,
        validator_signatures: null, callback_execute_action_index: callbackIndex,
        origin_action_index: callbackIndex };
}

describe('Database#getAttestation with several v1 response rounds', function () {
    afterEach(() => sinon.restore());

    it('names the terminal valid round and its callback after a retry', async function () {
        const db = makeDb([request(), round(510, 'no_quorum'), round(520, 'ok', 'valid', 530)]);
        const [data] = await db.getAttestation(detailConfig());
        expect(data.response).to.include({ action_index: 520, response_status: 'ok' });
        expect(data.callback_execute_action_index).to.equal(530);
        expect(data.callback_execute_derived).to.equal(false);
        expect(data.relay.response_relayed).to.equal(true);
    });

    it('skips an invalid round when a valid terminal round follows', async function () {
        const db = makeDb([request(), round(510, 'ok', 'invalid'), round(520, 'ok')]);
        const [data] = await db.getAttestation(detailConfig());
        expect(data.response.action_index).to.equal(520);
    });

    it('uses the newest valid retry while the request is pending', async function () {
        const db = makeDb([request('pending'), round(510, 'timeout'), round(520, 'provider_error')]);
        const [data] = await db.getAttestation(detailConfig());
        expect(data.response).to.include({ action_index: 520, response_status: 'provider_error' });
    });
});
