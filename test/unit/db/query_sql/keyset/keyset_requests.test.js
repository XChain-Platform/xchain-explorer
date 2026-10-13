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
 * API keyset paging as a caller sees it: processRequest over the real
 * Database with only the SQL round-trip stubbed. A malformed or doubled
 * cursor, or one asked of a list that cannot honour it, answers 400 before
 * any query runs; a keyset list carries the next page's cursor beside total
 * and data; the explorer transport never reads ?before=.
 */

'use strict';

const { expect }               = require('chai');
const proxyquire               = require('proxyquire');
const proxyquireNoCallThru     = require('proxyquire').noCallThru();
const Utility                  = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig, mockReq, mockRes } = require('../../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

let rows    = [];
let queried = false;

function row(actionIndex) {
    return { id: 7, total: 2, action_index: actionIndex, block_index: 900, tick: 'TEST', status: 'valid' };
}

class MockDB {
    constructor() {
        this.real = new Database({ configInfo, util });
        this.real.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        this.real.doQuery = async (config, sql) => {
            queried = true;
            if (/count\(/i.test(sql)) return [{ total: rows.length }];
            if (/MAX\(block_index\) AS tip/.test(sql)) return [{ tip: 900 }];
            return rows.map((r) => Object.assign({}, r));
        };
    }
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(config) { return this.real.getData(config); }
}

const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

const XChainExplorer = proxyquireNoCallThru('../../../../../src/XChainExplorer.js', {
    'express':      expressMock,
    './db/index.js': MockDB
});

async function request(explorer, path, query) {
    queried = false;
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query || {}), res);
    return { status: res._status, body: JSON.parse(res._body) };
}

describe('API keyset paging: refusals', function () {
    let explorer;
    before(function () { explorer = new XChainExplorer(mockApp, createConfigInfoStub()); });
    beforeEach(function () { rows = [row(499), row(480)]; });

    for (const bad of ['abc', '-1', '7.5', '1e5', '0x10', '', '9007199254740992', ['1', '2']]) {
        it('before=' + JSON.stringify(bad) + ' answers 400 INVALID_CURSOR without a query', async function () {
            const { status, body } = await request(explorer, '/BTC/api/issues/900/block', { before: bad });
            expect(status).to.equal(400);
            expect(body.code).to.equal('INVALID_CURSOR');
            expect(queried).to.equal(false);
        });
    }

    it('after= is validated the same way', async function () {
        const { status, body } = await request(explorer, '/BTC/api/commitments', { after: 'x' });
        expect(status).to.equal(400);
        expect(body.code).to.equal('INVALID_CURSOR');
    });

    it('before= and after= together answer 400', async function () {
        const { status, body } = await request(explorer, '/BTC/api/issues/900/block', { before: '5', after: '1' });
        expect(status).to.equal(400);
        expect(body.code).to.equal('INVALID_CURSOR');
    });

    it('a list whose cursor value can span rows refuses a keyset bound instead of skipping rows', async function () {
        const { status, body } = await request(explorer, '/BTC/api/sends/900/block', { before: '5' });
        expect(status).to.equal(400);
        expect(body.code).to.equal('CURSOR_UNSUPPORTED');
        expect(queried).to.equal(false);
    });

    it('a result-cached list still refuses the bound after its page 1 is cached', async function () {
        rows = [Object.assign(row(499), { id: 3 })];
        const first = await request(explorer, '/BTC/api/tokens/1BoatSLRHtKNngkdXEeobR76b53LETtpyT/address');
        expect(first.status).to.equal(200);
        const { status, body } = await request(explorer, '/BTC/api/tokens/1BoatSLRHtKNngkdXEeobR76b53LETtpyT/address', { before: '5' });
        expect(status).to.equal(400);
        expect(body.code).to.equal('CURSOR_UNSUPPORTED');
    });
});

describe('API keyset paging: the next cursor in the response', function () {
    let explorer;
    before(function () { explorer = new XChainExplorer(mockApp, createConfigInfoStub()); });
    beforeEach(function () { rows = [row(499), row(480)]; });

    it('a descending before= page carries next_before, the last row\'s cursor, as a string', async function () {
        const { status, body } = await request(explorer, '/BTC/api/issues/900/block', { before: '500' });
        expect(status).to.equal(200);
        expect(body.next_before).to.equal('480');
        expect(body).to.not.have.property('next_after');
        expect(body.total).to.equal(2);
        expect(body.data).to.have.length(2);
    });

    it('an ascending after= page carries next_after instead', async function () {
        rows = [row(480), row(499)];
        const { body } = await request(explorer, '/BTC/api/mints/900/block', { after: '400', sortorder: 'asc' });
        expect(body.next_after).to.equal('499');
        expect(body).to.not.have.property('next_before');
    });

    it('a ?page= response of a keyset list carries the cursor that starts a keyset walk', async function () {
        const { body } = await request(explorer, '/BTC/api/mints/900/block', { page: '1' });
        expect(body.next_before).to.equal('480');
    });

    it('commitments read the cursor from block_index', async function () {
        rows = [Object.assign(row(1), { block_index: 950000 }), Object.assign(row(2), { block_index: 949999 })];
        const { body } = await request(explorer, '/BTC/api/commitments', { before: '950001' });
        expect(body.next_before).to.equal('949999');
    });

    it('an empty page carries no cursor', async function () {
        rows = [];
        const { status, body } = await request(explorer, '/BTC/api/mints/900/block', { before: '1' });
        expect(status).to.equal(200);
        expect(body).to.not.have.property('next_before');
        expect(body).to.not.have.property('next_after');
    });

    it('a list without keyset paging carries no cursor', async function () {
        const { body } = await request(explorer, '/BTC/api/sends/900/block');
        expect(body).to.not.have.property('next_before');
    });
});

describe('API keyset paging: the explorer transport', function () {
    it('never reads ?before=, so a value the API would refuse changes nothing', async function () {
        const db = new Database({ configInfo, util });
        db.doQuery = async () => [];
        const config = makeConfig({ type: 'explorer', data: { method: 'getMints', type: 'block', search: '900',
            query: { before: 'abc', start: 0, length: 10 } } });
        await db.getQuery(config);
        expect(config.data.sql.keyset).to.equal(undefined);
        expect(config.data.sql.where.offset).to.not.include('?');
    });
});
