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

const { expect } = require('chai');
const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { NODEPROOF, ROLLCALL } = require('../../../../src/action-detail/consensus.js');

const proxyquire = require('proxyquire');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const util = new Utility(createConfigInfoStub());
const config = { coin: 'BTC' };

// Main rows carry exactly the columns the real detail statements select: no status.
const DOMAIN_ROWS = {
    5: { table: /FROM\s+full_node_verifications m/,
         row: { action: 'NODEPROOF', action_format: 0, action_index: 5, challenge_id: 'cc', epoch_height: 90 } },
    6: { table: /FROM\s+rollcall_actions r/,
         row: { action: 'ROLLCALL', action_format: 1, action_index: 6, epoch_height: 100, carried_count: 2, first_seen_count: 1 } }
};
const TYPES = { 5: 'NODEPROOF', 6: 'ROLLCALL', 7: 'NODEPROOF', 8: 'ROLLCALL' };

function makeDatabase() {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.schemaTableMemo = { BTC: { rollcall_actions: { present: true, at: Date.now() } } };
    db.getActionType = async (cfg, idx) => TYPES[Number(idx)];
    db.getActionFeeData = async () => null;
    db.getTransactionData = async () => null;
    db.buildActionPreload = async () => null;
    db.doQuery = async (cfg, sql, args) => {
        const text = String(sql);
        const entry = DOMAIN_ROWS[Number(args && args[0])];
        if (entry && entry.table.test(text) && text.includes('LIMIT 1')) return [Object.assign({}, entry.row)];
        return [];
    };
    return db;
}

describe('consensus action detail status derivation', function () {
    it('marks a stored NODEPROOF verdict valid and leaves a rowless verdict unknown', async function () {
        const db = { util, doQuery: async () => [] };
        const stored = { challenge_id: 'challenge' };
        const rowless = {};
        await NODEPROOF.afterMain({ db, config, action_index: 1 }, stored);
        await NODEPROOF.afterMain({ db, config, action_index: 2 }, rowless);
        expect(stored.status).to.equal('valid');
        expect(rowless).to.not.have.property('status');
    });

    it('marks a stored ROLLCALL valid and leaves a rowless legacy action unknown', async function () {
        const db = {
            util,
            schemaTableMemo: { BTC: { rollcall_actions: { present: true, at: Date.now() } } },
            doQuery: async () => []
        };
        const stored = { epoch_height: 100, carried_count: 0, gates: null };
        const rowless = {};
        await ROLLCALL.afterMain({ db, config, action_index: 3 }, stored);
        await ROLLCALL.afterMain({ db, config, action_index: 4 }, rowless);
        expect(stored.status).to.equal('valid');
        expect(rowless).to.not.have.property('status');
    });
});

describe('consensus action status through getActionData and the summary rows', function () {
    it('serves valid for stored NODEPROOF and ROLLCALL rows and no status without a row', async function () {
        const db = makeDatabase();
        expect((await db.getActionData(config, 5)).status).to.equal('valid');
        expect((await db.getActionData(config, 6)).status).to.equal('valid');
        expect((await db.getActionData(config, 7)).status).to.equal(undefined);
        expect((await db.getActionData(config, 8)).status).to.equal(undefined);
    });

    it('carries the derived status onto the transaction and history summary rows', async function () {
        const db = makeDatabase();
        const rows = [5, 6, 7].map((action_index) => ({ action_index, action: TYPES[action_index] }));
        await db.getActionSummaryData(config, rows);
        expect(rows.map((row) => row.status)).to.deep.equal(['valid', 'valid', undefined]);
    });
});
