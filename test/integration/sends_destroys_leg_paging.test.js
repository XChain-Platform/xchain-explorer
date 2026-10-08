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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const supertest = require('supertest');
const db = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR3 = 'bc1qaddr3ccccccccccccccccccccccccccc';

let request;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    await db.query(`INSERT INTO sends
        (action_index, tick_id, destination_id, amount, memo_id, status_id, leg_ordinal)
        VALUES (19, 2, 3, '25.00000000', NULL, 1, 1)`);
    await db.query('ALTER TABLE destroys DROP INDEX action_index');
    await db.query(`INSERT INTO destroys
        (action_index, tick_id, amount, memo_id, status_id, leg_ordinal)
        VALUES (20, 2, '50.00000000', NULL, 1, 1)`);
    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.query('DELETE FROM destroys WHERE action_index=20 AND leg_ordinal=1');
    await db.query('CREATE UNIQUE INDEX action_index ON destroys (action_index)');
    await db.teardownDatabase();
});

describe('multi-leg SEND and DESTROY paging', function () {
    it('uses the API limit and offset as action units', async function () {
        const first = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=1&page=1`);
        const second = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=1&page=2`);

        expect(first.status).to.equal(200);
        expect(first.body.total).to.equal(7);
        expect(first.body.data).to.have.lengthOf(2);
        expect(first.body.data.map(row => Number(row.action_index))).to.deep.equal([19, 19]);
        expect(first.body.data.map(row => row.tick)).to.deep.equal(['XCHAIN', 'TOKENONE']);

        expect(second.status).to.equal(200);
        expect(second.body.data).to.have.lengthOf(1);
        expect(Number(second.body.data[0].action_index)).to.equal(16);
    });

    it('keeps every SEND leg inside one explorer cursor page', async function () {
        const first = await request.get(
            `/RBTC/explorer/sends/${ADDR1}/address?start=0&length=1&action=first`
        );
        const second = await request.get(
            `/RBTC/explorer/sends/${ADDR1}/address?start=1&length=1&action=next&offset=19&total=7`
        );

        expect(first.status).to.equal(200);
        expect(first.body.recordsTotal).to.equal(7);
        expect(first.body.data).to.have.lengthOf(2);
        expect(first.body.data.map(row => Number(row[row.length - 1]))).to.deep.equal([19, 19]);

        expect(second.status).to.equal(200);
        expect(second.body.data).to.have.lengthOf(1);
        expect(Number(second.body.data[0][second.body.data[0].length - 1])).to.equal(16);
    });
});

describe('whole-action SEND and DESTROY results', function () {
    it('applies a raw explorer start in whole-action units', async function () {
        const first = await request.get(
            `/RBTC/explorer/sends/${ADDR1}/address?start=0&length=1`
        );
        const second = await request.get(
            `/RBTC/explorer/sends/${ADDR1}/address?start=1&length=1`
        );

        expect(first.status).to.equal(200);
        expect(first.body.data).to.have.lengthOf(2);
        expect(first.body.data.map(row => Number(row[row.length - 1]))).to.deep.equal([19, 19]);

        expect(second.status).to.equal(200);
        expect(second.body.data).to.have.lengthOf(1);
        expect(Number(second.body.data[0][second.body.data[0].length - 1])).to.equal(16);
    });

    it('counts one DESTROY action and returns both legs', async function () {
        const api = await request.get(`/RBTC/api/destroys/${ADDR3}/address?limit=1`);
        const explorer = await request.get(
            `/RBTC/explorer/destroys/${ADDR3}/address?start=0&length=1&action=first`
        );

        expect(api.status).to.equal(200);
        expect(api.body.total).to.equal(1);
        expect(api.body.data).to.have.lengthOf(2);
        expect(api.body.data.map(row => row.tick)).to.deep.equal(['XCHAIN', 'TOKENONE']);

        expect(explorer.status).to.equal(200);
        expect(explorer.body.recordsTotal).to.equal(1);
        expect(explorer.body.data).to.have.lengthOf(2);
        expect(explorer.body.data.map(row => Number(row[row.length - 1]))).to.deep.equal([20, 20]);
    });
});
