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
const REQUEST_ID = 'b'.repeat(64);
const LIFECYCLE = 'FROM attests m LEFT JOIN actions';
const LEGS_ORDER = 'ORDER BY m.version ASC, m.action_index ASC';
const RESPONSE_WHERE = 'WHERE m.request_id=? AND m.version=1';

function detailConfig(limit){
    return makeConfig({ coin: 'BTC', type: 'api', data: { method: 'getAttestation',
        search: REQUEST_ID, type: null,
        sql: { order: 'DESC', limit, where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] } } } });
}

function round(actionIndex, responseStatus, status = 'valid', callbackIndex = null){
    return { action: 'ATTEST', action_index: actionIndex, version: 1, request_id: REQUEST_ID,
        provider_id: 'http_get', response_status: responseStatus, status,
        validator_signatures: null, callback_execute_action_index: callbackIndex,
        origin_action_index: callbackIndex };
}

function history(requestStatus, retries, terminal){
    const legs = [{ action: 'ATTEST', action_index: 1, version: 0, request_id: REQUEST_ID,
        provider_id: 'http_get', request_status: requestStatus, responsible_set_json: null,
        callback_params_json: null, origin_chain: null, origin_action_index: null }];
    for(let i = 0; i < retries; i++) legs.push(round(10 + i, 'timeout'));
    if(terminal) legs.push(terminal);
    return legs;
}

// The legs read honours its LIMIT; the response read returns the row the stub was
// told the database ranks first, and records the SQL it was handed.
function makeDb(legs, ranked){
    const db = new Database({ configInfo, util, hubOperational: null });
    const seen = [];
    db.doQuery = sinon.stub().callsFake(async (_cfg, query) => {
        const sql = String(query).replace(/\s+/g, ' ');
        if(!sql.includes(LIFECYCLE)) return [];
        seen.push(sql);
        if(sql.includes(RESPONSE_WHERE)) return ranked ? [ranked] : [];
        return legs.slice(0, Number(sql.match(/LIMIT (\d+)\s*$/)[1]));
    });
    return { db, seen };
}

describe('Database#getAttestation when the legs read hits its LIMIT', function () {
    afterEach(() => sinon.restore());

    it('reads the terminal round that sits past the cap and takes its callback', async function () {
        const ok = round(900, 'ok', 'valid', 930);
        const { db, seen } = makeDb(history('fulfilled', 100, ok), ok);
        const [data] = await db.getAttestation(detailConfig(100));
        expect(data.response).to.include({ action_index: 900, response_status: 'ok' });
        expect(data.callback_execute_action_index).to.equal(930);
        expect(data.callback_execute_derived).to.equal(false);
        expect(data.relay.response_relayed).to.equal(true);
        expect(data.legs).to.have.length(100);
        const ranking = seen.find(s => s.includes(RESPONSE_WHERE));
        expect(ranking).to.match(/ORDER BY CASE WHEN s1\.status='valid' AND m\.response_status IN \('ok','expired'\) THEN 2/);
        expect(ranking).to.match(/LIMIT 1$/);
    });

    it('names the newest retry past the cap while the request is still pending', async function () {
        const { db } = makeDb(history('pending', 150, null), round(159, 'timeout'));
        const [data] = await db.getAttestation(detailConfig(100));
        expect(data.response).to.include({ action_index: 159, response_status: 'timeout' });
    });

    it('falls back to the newest retry in the read when the response read finds nothing', async function () {
        const { db } = makeDb(history('pending', 150, null), null);
        const [data] = await db.getAttestation(detailConfig(100));
        expect(data.response).to.include({ action_index: 108, response_status: 'timeout' });
    });

    it('issues no extra read when the cap is not reached or the terminal round is in it', async function () {
        const short = makeDb(history('fulfilled', 2, round(50, 'ok', 'valid', 60)), null);
        await short.db.getAttestation(detailConfig(100));
        expect(short.seen.filter(s => s.includes(RESPONSE_WHERE))).to.have.length(0);
        const full = makeDb(history('fulfilled', 3, round(50, 'ok', 'valid', 60)), null);
        const [data] = await full.db.getAttestation(detailConfig(5));
        expect(data.response.action_index).to.equal(50);
        expect(full.seen.filter(s => s.includes(RESPONSE_WHERE))).to.have.length(0);
    });

    it('runs the same number of reads at two truncated history sizes', async function () {
        const counts = [];
        for(const retries of [150, 1500]){
            const ok = round(5000, 'ok', 'valid', 5001);
            const { db } = makeDb(history('fulfilled', retries, ok), ok);
            await db.getAttestation(detailConfig(100));
            counts.push(db.doQuery.callCount);
        }
        expect(counts[0]).to.equal(counts[1]);
    });
});
