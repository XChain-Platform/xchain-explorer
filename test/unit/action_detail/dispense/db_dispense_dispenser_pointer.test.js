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
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../src/lib/utility.js');
const dispensers = require('../../../../src/action-detail/dispensers.js');
const { applyPostPasses } = require('../../../../src/db/query_sql/data_post.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

const ZERO_FILL_STATUS = 'invalid: insufficient funds ';
const ZERO_FILL_REASON = 'The payment was too small to buy one fill at the dispenser\'s price; the coin was kept.';

function detailDatabase(rows) {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.getActionType = async (config, actionIndex) => rows[actionIndex].action;
    db.getActionFeeData = async () => null;
    db.getTransactionData = async () => null;
    db.doQuery = async (config, sql, args) => {
        const statement = String(sql);
        const row = rows[Number(args && args[0])];
        if(!row) return [];
        if(row.action === 'DISPENSE' && statement.includes('FROM\n                dispenses m'))
            return [Object.assign({}, row)];
        if(row.action === 'DISPENSER_CANCEL' && statement.includes('FROM\n                    dispenser_cancels m'))
            return [Object.assign({}, row)];
        return [];
    };
    return db;
}

describe('DISPENSE action detail dispenser pointer', function () {
    it('returns dispenser 479 for DISPENSE action 480', async function () {
        const configInfo = createConfigInfoStub();
        const db = new Database({ configInfo, util: new Utility(configInfo) });
        const dispenseQueries = [];

        db.getActionType = async () => 'DISPENSE';
        db.getActionFeeData = async () => null;
        db.getTransactionData = async () => null;
        db.doQuery = async (config, sql, args) => {
            const statement = String(sql);
            if(statement.includes('FROM\n                dispenses m')) {
                dispenseQueries.push({ statement, args });
                const row = {
                    action: 'DISPENSE',
                    action_index: 480,
                    status: 'valid'
                };
                if(statement.split(/\bFROM\b/)[0].includes('m.dispenser_action_index'))
                    row.dispenser_action_index = 479;
                return [row];
            }
            return [];
        };

        const data = await db.getActionData({ coin: 'RDOGE', data: {} }, 480);
        const handlerQuery = dispensers.DISPENSE.queries().query;

        assert.strictEqual(dispenseQueries.length, 1);
        assert.strictEqual(handlerQuery, dispenseQueries[0].statement);
        assert.ok(dispenseQueries[0].statement.includes('INNER JOIN dispensers'));
        assert.ok(dispenseQueries[0].statement
            .split(/\bFROM\b/)[0]
            .includes('m.dispenser_action_index'));
        assert.deepStrictEqual(dispenseQueries[0].args, [480]);
        assert.strictEqual(data.dispenser_action_index, 479);
    });
});

describe('DISPENSE action detail status reason', function () {
    const rows = {
        501: { action: 'DISPENSE', action_index: 501, status: ZERO_FILL_STATUS },
        502: { action: 'DISPENSE', action_index: 502, status: 'valid' },
        503: { action: 'DISPENSER_CANCEL', action_index: 503, status: ZERO_FILL_STATUS }
    };

    it('explains only the exact zero-fill DISPENSE status', async function () {
        const db = detailDatabase(rows);
        const config = { coin: 'RDOGE', data: {} };

        assert.strictEqual((await db.getActionData(config, 501)).status_reason, ZERO_FILL_REASON);
        assert.strictEqual((await db.getActionData(config, 502)).status_reason, null);
        assert.strictEqual((await db.getActionData(config, 503)).status_reason, null);
    });
});

describe('DISPENSE action list status reason', function () {
    it('shapes zero-fill, other-status, and non-DISPENSE rows without a query', async function () {
        const rows = [
            { action: 'DISPENSE', status: ZERO_FILL_STATUS },
            { action: 'DISPENSE', status: 'valid' },
            { action: 'SEND', status: ZERO_FILL_STATUS }
        ];

        await applyPostPasses({}, { data: { method: 'getDispenses' } }, rows);

        assert.deepStrictEqual(rows.map((row) => row.status_reason), [ZERO_FILL_REASON, null, null]);
    });
});

describe('DISPENSE action summary status reason', function () {
    it('preserves the derived reason on history and transaction action rows', async function () {
        const configInfo = createConfigInfoStub();
        const db = new Database({ configInfo, util: new Utility(configInfo) });
        db.getActionDataBatch = async () => new Map([
            [601, { action: 'DISPENSE', status: ZERO_FILL_STATUS, status_reason: ZERO_FILL_REASON }],
            [602, { action: 'SEND', status: ZERO_FILL_STATUS, status_reason: null }]
        ]);
        const rows = [{ action_index: 601 }, { action_index: 602 }];

        await db.getActionSummaryData({}, rows);

        assert.deepStrictEqual(rows.map((row) => row.status_reason), [ZERO_FILL_REASON, null]);
    });
});
