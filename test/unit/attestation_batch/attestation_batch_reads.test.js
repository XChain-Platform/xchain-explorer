/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const Utility = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig } = require('../../fixtures/mock-query-args.js');
const { stakeLifecycleRows } = require('../../../src/explorer/paging/list_rows.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const configInfo = createConfigInfoStub();
const util = new Utility(configInfo);
const BATCH_KEY = 'a'.repeat(64);
const REQUEST_A = 'b'.repeat(64);
const REQUEST_B = 'c'.repeat(64);
const COLUMNS = [
    'batch_action_index', 'batch_window_start', 'batch_window_end', 'batch_row_count'
].map(COLUMN_NAME => ({ COLUMN_NAME }));

function config(search, method = 'getAttestation'){
    return makeConfig({
        coin: 'DOGE',
        type: 'api',
        data: {
            method,
            search,
            sql: {
                order: 'DESC',
                limit: 25,
                where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
            }
        }
    });
}

function makeDb(handler){
    const db = new Database({ configInfo, util });
    db.doQuery = sinon.stub().callsFake(async (cfg, sql, args) => {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        if(flat.includes('information_schema.COLUMNS')) return COLUMNS;
        return handler ? handler(flat, args) : [];
    });
    return db;
}

function batchRows(rowCount = 2){
    return [{
        action: 'ATTEST', action_index: 500, version: 5, request_id: BATCH_KEY,
        batch_key: BATCH_KEY, batch_window_start: 1700000000, batch_window_end: 1700003600,
        batch_row_count: rowCount, source: 'publisher-a', block_index: 50,
        tx_hash: '1'.repeat(64), status: 'valid'
    }, {
        action: 'ATTEST', action_index: 501, version: 6, request_id: BATCH_KEY,
        batch_key: BATCH_KEY, source: 'publisher-a', block_index: 51,
        tx_hash: '2'.repeat(64), status: 'valid'
    }, {
        action: 'ATTEST', action_index: 510, version: 5, request_id: BATCH_KEY,
        batch_key: BATCH_KEY, batch_window_start: 1700000000, batch_window_end: 1700003600,
        batch_row_count: rowCount, source: 'publisher-b', block_index: 52,
        tx_hash: '3'.repeat(64), status: 'valid'
    }];
}

function carriedResponses(){
    return [{
        action_index: 300, version: 1, request_id: REQUEST_A, request_action_index: 200,
        response_status: 'ok', validator_signatures: '[{"pubkey":"aa","sig":"11"}]',
        batch_action_index: 500, status: 'valid'
    }, {
        action_index: 301, version: 1, request_id: REQUEST_B, request_action_index: 201,
        response_status: 'timeout', validator_signatures: '[]',
        batch_action_index: 500, status: 'valid'
    }];
}

describe('ATTEST batch list reads', function(){
    it('selects the batch key, window fields, row count and response batch link', async function(){
        const db = makeDb();
        const [sql] = await db.getAttestations(config(null, 'getAttestations'));
        expect(sql).to.include('as batch_key');
        for(const name of COLUMNS.map(r => r.COLUMN_NAME)) expect(sql).to.include('m.' + name);
        await db.getAttestationsSince(config(null, 'getAttestationsSince'), 0, 25);
        await db.getAttestationByActionIndex(config(null, 'getAttestationByActionIndex'), 1);
        const reads = db.doQuery.getCalls().map(c => String(c.args[1]))
            .filter(text => text.includes('FROM') && !text.includes('information_schema'));
        expect(reads).to.have.lengthOf(2);
        for(const text of reads)
            for(const name of COLUMNS.map(r => r.COLUMN_NAME)) expect(text).to.include('m.' + name);
    });

    [
        { version: 5, batch_key: BATCH_KEY, batch_window_start: 1, batch_window_end: 2, batch_row_count: 2 },
        { version: 6, batch_key: BATCH_KEY, batch_window_start: null, batch_window_end: null, batch_row_count: null },
        { version: 0 },
        { version: 1, batch_action_index: 500 }
    ].forEach(function(fixture){
        it('preserves the appended batch fields for a v' + fixture.version + ' list row', function(){
            const row = stakeLifecycleRows(Object.assign({
                block_index: 10, timestamp: 20, source: 'source', provider_id: 'http_get',
                request_id: REQUEST_A, request_status: null, response_status: null,
                action_index: 30, payload: null, callback_params_json: null, fee_payer: null
            }, fixture), { count_reverse: 1, status: 1, method: 'getAttestations' });
            expect(row.slice(14)).to.deep.equal([
                fixture.batch_key, fixture.batch_window_start, fixture.batch_window_end,
                fixture.batch_row_count, fixture.batch_action_index
            ]);
        });
    });

    it('omits optional batch fields when the connected replica has none', async function(){
        const db = makeDb();
        db.doQuery = sinon.stub().resolves([]);
        const [sql] = await db.getAttestations(config(null, 'getAttestations'));
        expect(sql).to.not.include('batch_window_start');
        expect(sql).to.not.include('batch_action_index');
    });

    it('keeps a legacy lifecycle readable when the replica has no batch columns', async function(){
        const request = {
            action_index: 200, version: 0, request_id: REQUEST_A, provider_id: 'http_get',
            request_status: 'pending', responsible_set_json: '[]', callback_params_json: '[]'
        };
        const db = makeDb();
        db.doQuery = sinon.stub().callsFake(async (cfg, sql) => {
            const flat = String(sql).replace(/\s+/g, ' ').trim();
            if(flat.includes('information_schema.COLUMNS')) return [];
            if(flat.includes('WHERE m.request_id=?')) return [request];
            return [];
        });
        const [out] = await db.getAttestation(config(REQUEST_A));
        const lifecycleSql = db.doQuery.getCalls().map(c => String(c.args[1]))
            .find(sql => sql.includes('WHERE m.request_id=?'));
        expect(lifecycleSql).to.not.include('batch_window_start');
        expect(out.request.action_index).to.equal(200);
        expect(out).to.not.have.property('batch');
    });
});

describe('ATTEST batch lifecycle read', function(){
    it('returns a head, its continuation, two carried responses and one duplicate head', async function(){
        const db = makeDb((sql) => {
            if(sql.includes('WHERE m.action_index=?')) return [batchRows()[0]];
            if(sql.includes('WHERE m.request_id=?')) return batchRows();
            if(sql.includes('WHERE r.version=1 AND r.batch_action_index=?')) return carriedResponses();
            return [];
        });
        const [out] = await db.getAttestation(config(500));
        expect(out.batch.action_index).to.equal(500);
        expect(out.batch.batch_key).to.equal(BATCH_KEY);
        expect(out.continuations.map(r => r.action_index)).to.deep.equal([501]);
        expect(out.responses.map(r => [r.request_id, r.request_action_index])).to.deep.equal([
            [REQUEST_A, 200], [REQUEST_B, 201]
        ]);
        expect(out.responses[0].quorum_signatures).to.deep.equal([{ pubkey: 'aa', sig: '11' }]);
        expect(out.duplicates).to.deep.equal([{
            action_index: 510, tx_hash: '3'.repeat(64), source: 'publisher-b', block_index: 52
        }]);
    });

    it('returns an empty response list for a row_count 0 batch without a response query', async function(){
        const db = makeDb((sql) => {
            if(sql.includes('WHERE m.request_id=?')) return [batchRows(0)[0]];
            throw new Error('unexpected query: ' + sql);
        });
        const [out] = await db.getAttestation(config(BATCH_KEY));
        expect(out.batch.batch_row_count).to.equal(0);
        expect(out.responses).to.deep.equal([]);
        expect(out.continuations).to.deep.equal([]);
        expect(out.duplicates).to.deep.equal([]);
    });

    it('resolves a v6 continuation lookup to its publisher head', async function(){
        const rows = batchRows(0).slice(0, 2);
        const db = makeDb((sql) => {
            if(sql.includes('WHERE m.action_index=?')) return [rows[1]];
            if(sql.includes('WHERE m.request_id=?')) return rows;
            return [];
        });
        const [out] = await db.getAttestation(config(501));
        expect(out.batch.action_index).to.equal(500);
        expect(out.continuations.map(r => r.action_index)).to.deep.equal([501]);
    });

    it('keeps a v0 lifecycle shape and carries batch_action_index on its v1 response', async function(){
        const rows = [{
            action: 'ATTEST', action_index: 200, version: 0, request_id: REQUEST_A,
            provider_id: 'http_get', request_status: 'fulfilled', responsible_set_json: '[]',
            callback_params_json: '[]', status: 'valid'
        }, {
            action: 'ATTEST', action_index: 300, version: 1, request_id: REQUEST_A,
            provider_id: 'http_get', response_status: 'ok', validator_signatures: '[]',
            batch_action_index: 500, status: 'valid'
        }];
        const db = makeDb(sql => sql.includes('WHERE m.request_id=?') ? rows : []);
        const [out] = await db.getAttestation(config(REQUEST_A));
        expect(out).to.include.keys('query', 'request_id', 'provider_id', 'legs', 'request',
            'response', 'expiry', 'relay', 'callback_execute_action_index', 'callback_execute_derived');
        expect(out).to.not.have.property('batch');
        expect(out.request.action_index).to.equal(200);
        expect(out.response.action_index).to.equal(300);
        expect(out.response.batch_action_index).to.equal(500);
    });
});
