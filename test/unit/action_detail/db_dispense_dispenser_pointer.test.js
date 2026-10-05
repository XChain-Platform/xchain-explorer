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
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

describe('DISPENSE action detail dispenser pointer', function () {
    it('returns the dispenser action index that served the dispense', async function () {
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
                if(statement.includes('INNER JOIN dispensers')) return [{
                    action: 'DISPENSE',
                    action_index: 480,
                    status: 'valid'
                }];
                return [{ dispenser_action_index: 479 }];
            }
            return [];
        };

        const data = await db.getActionData({ coin: 'RDOGE', data: {} }, 480);

        assert.strictEqual(dispenseQueries.length, 2);
        assert.ok(dispenseQueries[0].statement.includes('INNER JOIN dispensers'));
        assert.ok(dispenseQueries[1].statement
            .split(/\bFROM\b/)[0]
            .includes('m.dispenser_action_index'));
        assert.deepStrictEqual(dispenseQueries.map(({ args }) => args), [[480], [480]]);
        assert.strictEqual(data.dispenser_action_index, 479);
    });
});
