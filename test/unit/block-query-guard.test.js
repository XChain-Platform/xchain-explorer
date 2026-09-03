'use strict';

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
 * Unit tests for the /{COIN}/api/block/{QUERY} malformed-id refusal (D-E062).
 *
 * db.js's getBlock bound config.data.search straight into `WHERE
 * b1.block_index=?`, and MariaDB coerces a non-numeric string to 0 in a numeric
 * comparison, so /api/block/zzz-no-such-entity-9999 answered 200 with BLOCK 0's
 * real, well-formed record. That is worse than the 500 its checkpoint sibling
 * threw (D-E060): nothing in the response says the id was not understood, so a
 * client cannot detect it and a cache will happily store it.
 *
 * The refusal lives in the reader (a DbInputError), not in the route table, so
 * every caller of getBlock is covered. These tests drive the REAL getBlock
 * through processRequest with only the SQL round-trip stubbed, so the guard
 * under test is the shipping one and the assertion is on the HTTP answer.
 */

const { expect }               = require('chai');
const proxyquire               = require('proxyquire');
const proxyquireNoCallThru     = require('proxyquire').noCallThru();
const Utility                  = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../fixtures/mock-query-args.js');
const mockResults              = require('../fixtures/mock-db-results.js');

// The real Database, with the mariadb pool factory stubbed out.
const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

/** Captured cfg from the most-recent getData() call */
let capturedConfig = null;
/** Set true whenever the stubbed SQL round-trip actually ran */
let queried = false;

// Delegates to the real db.js reader so the refusal being asserted is the
// shipping one; only doQuery (the SQL round-trip) is stubbed. Block 0's row is
// the wrong answer an unguarded coercion hands back, so returning exactly that
// makes a regression visible as a 200 carrying block_index 0 rather than as a
// silent pass.
class MockDB {
    constructor() {
        this.real = new Database({ configInfo, util });
        this.real.doQuery = async () => {
            queried = true;
            return mockResults.blockRow();
        };
    }
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(config) {
        capturedConfig = config;
        return this.real.getData(config);
    }
}

const mockApp = {
    use: () => {},
    get: () => {},
    post: () => {},
    enable: () => {}
};
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

const XChainExplorer = proxyquireNoCallThru('../../src/XChainExplorer.js', {
    'express':  expressMock,
    './db.js':  MockDB
});

function makeExplorer(configOverrides) {
    return new XChainExplorer(mockApp, createConfigInfoStub(configOverrides));
}

/** Drive processRequest and return { cfg, res } */
async function request(explorer, path, query = {}) {
    capturedConfig = null;
    queried        = false;
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query), res);
    return { cfg: capturedConfig, res };
}

describe('XChainExplorer.processRequest – /api/block/{QUERY} malformed id', function () {

    let explorer;

    before(function () {
        explorer = makeExplorer();
    });

    ['zzz-no-such-entity-9999', 'junk', '9junk', '7.5', '-1', '1e5', '0x7', '500 ', 'null'].forEach((bad) => {
        it(`400s /BTC/api/block/${JSON.stringify(bad)} instead of answering with block 0`, async function () {
            const { res } = await request(explorer, '/BTC/api/block/' + encodeURIComponent(bad));
            expect(res._status).to.equal(400);
            // processRequest serializes the api body itself, so _body is a JSON string.
            const body = JSON.parse(res._body);
            expect(body.code).to.equal('INVALID_BLOCK_INDEX');
            expect(body).to.not.have.property('block_index');
            expect(queried, 'the DB was never queried').to.be.false;
        });
    });

    it('never leaks the malformed segment back into the response body', async function () {
        const { res } = await request(explorer, '/BTC/api/block/' + encodeURIComponent('<script>x</script>'));
        expect(res._status).to.equal(400);
        expect(res._body).to.not.contain('<script>');
    });

    it('still serves a well-formed /BTC/api/block/500', async function () {
        const { cfg, res } = await request(explorer, '/BTC/api/block/500');
        expect(cfg, 'the DB was queried').to.not.be.null;
        expect(cfg.data.method).to.equal('getBlock');
        expect(cfg.data.search).to.equal('500');
        expect(res._status).to.equal(200);
        expect(JSON.parse(res._body)).to.have.property('block_index');
    });

    it('still serves block 0 when block 0 is what was actually asked for', async function () {
        const { res } = await request(explorer, '/BTC/api/block/0');
        expect(res._status).to.equal(200);
        expect(JSON.parse(res._body)).to.have.property('block_index');
    });

    it('a DbInputError answers 4xx, not the 500 a genuine DB failure gets', async function () {
        const { res } = await request(explorer, '/BTC/api/block/zzz');
        expect(res._status).to.be.within(400, 499);
        expect(JSON.parse(res._body).code).to.not.equal('DB_ERROR');
    });

});
