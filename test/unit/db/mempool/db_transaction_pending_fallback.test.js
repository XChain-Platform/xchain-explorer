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
 *********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../../src/db/index.js');
const Utility    = require('../../../../src/lib/utility.js');

const HASH = 'ABCDEF012345';
const ROW = {
    tx_hash: HASH,
    source: 'sourceAddress',
    data: 'SEND|0|XCP|25|destinationAddress|memo',
    first_seen: 1787000000
};

function config(search, type = 'tx_hash') {
    return {
        coin: 'TLTC',
        data: {
            search,
            type,
            sql: { where: { data: 'm.tx_index IS NOT NULL' } }
        }
    };
}

function makeDb(queryRows = []) {
    const db = Object.create(Database.prototype);
    db.util = new Utility();
    db.doQuery = sinon.stub().resolves(queryRows);
    db.getDecoderMempoolRows = sinon.stub().resolves([ROW]);
    sinon.spy(db, 'decodeMempoolRow');
    db.getTransactionData = sinon.stub().resolves(null);
    db.getActionSummaryData = sinon.stub().callsFake(async (cfg, actions) => actions);
    return db;
}

afterEach(function () { sinon.restore(); });

describe('Database#getTransaction pending mempool match', function () {
    it('returns a decoded pending transaction when the indexed row is absent', async function () {
        const db = makeDb();
        const cfg = config(HASH);

        const [data] = await db.getTransaction(cfg);

        expect(data).to.deep.equal({
            tx_hash: HASH,
            source: ROW.source,
            tx_index: null,
            block_index: null,
            timestamp: ROW.first_seen,
            pending: true,
            tx_data: ROW.data,
            actions: [{ action_index: null, action: 'SEND' }]
        });
        sinon.assert.calledOnceWithExactly(db.getDecoderMempoolRows, cfg, 500);
        sinon.assert.calledOnce(db.decodeMempoolRow);
        sinon.assert.notCalled(db.getTransactionData);
        sinon.assert.notCalled(db.getActionSummaryData);
    });

    it('matches the transaction hash case-insensitively', async function () {
        const db = makeDb();

        const [data] = await db.getTransaction(config(HASH.toLowerCase()));

        expect(data.tx_hash).to.equal(HASH);
        expect(data.pending).to.equal(true);
    });
});

describe('Database#getTransaction pending mempool precedence', function () {
    it('leaves an unknown hash without a tx_hash', async function () {
        const db = makeDb();

        const [data] = await db.getTransaction(config('unknown'));

        expect(data).not.to.have.property('tx_hash');
        expect(data.actions).to.deep.equal([]);
        sinon.assert.calledOnce(db.getDecoderMempoolRows);
        sinon.assert.notCalled(db.decodeMempoolRow);
    });

    it('never consults the mempool for a tx_index search', async function () {
        const db = makeDb();

        const [data] = await db.getTransaction(config(123, 'tx_index'));

        expect(data).not.to.have.property('tx_hash');
        sinon.assert.notCalled(db.getDecoderMempoolRows);
        sinon.assert.notCalled(db.decodeMempoolRow);
    });

    it('prefers a confirmed row over a matching mempool row', async function () {
        const confirmed = {
            tx_index: 9,
            tx_hash: HASH,
            block_index: 100,
            timestamp: 1787000100,
            source: 'confirmedSource'
        };
        const db = makeDb([confirmed]);

        const [data] = await db.getTransaction(config(HASH));

        expect(data.tx_hash).to.equal(HASH);
        expect(data.block_index).to.equal(100);
        expect(data).not.to.have.property('pending');
        sinon.assert.notCalled(db.getDecoderMempoolRows);
        sinon.assert.notCalled(db.decodeMempoolRow);
    });
});
