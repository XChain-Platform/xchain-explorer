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
 * Regression coverage for a VOTE v1 ballot's own status.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/lib/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { explorerRow } = require('../../src/explorer/paging/explorer_row.js');

const Database = proxyquire('../../src/db/index.js', {
    './connection.js': proxyquire('../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const BALLOT = 5201;
const POLL   = 5100;

const BALLOT_MAIN_ROW = {
    action:        'VOTE',
    action_format: 1,
    action_index:  BALLOT,
    source:        'DAddressVoter111111111111111111',
    poll_status:   null,
    delegator:     null,
    status:        null,
    block_index:   5300,
    timestamp:     1785280000,
    tx_hash:       'ballot-tx-hash',
    tx_index:      77
};

const BALLOT_CHOICE_ROWS = [
    { poll_index: POLL, choice: 0, share: '1', memo: 'gm' }
];

function makeDb(routes) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        db.queries.push(String(sql));
        for (const [needle, rows] of routes)
            if (String(sql).includes(needle)) return rows;
        return [];
    };
    db.getActionType      = async () => 'VOTE';
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'BTC', data: {} };

describe('VOTE v1 ballot status @regression', function () {
    it('carries the ballot choice rows own status', async function () {
        const db = makeDb([
            ['vote_delegations', [BALLOT_MAIN_ROW]],
            ['FROM votes WHERE', BALLOT_CHOICE_ROWS],
            ['index_statuses s1', [{ status: 'valid' }]]
        ]);
        const data = await db.getActionData(config, BALLOT);
        assert.strictEqual(data.vote_kind, 'ballot');
        assert.strictEqual(data.status, 'valid', 'a recorded ballot must not read back status: null');
        assert.strictEqual(data.poll_ref, POLL);
        assert.deepStrictEqual(data.ballot, [{ choice: 0, share: '1' }]);
    });

    it('reads indexed status with a valid fallback for a stored ballot', async function () {
        const db = makeDb([
            ['vote_delegations', [BALLOT_MAIN_ROW]],
            ['FROM votes WHERE', BALLOT_CHOICE_ROWS],
            ['index_statuses s1', [{ status: 'valid' }]]
        ]);
        await db.getActionData(config, BALLOT);
        const statusQuery = db.queries.find(q => q.includes('index_statuses s1'));
        assert.ok(statusQuery, 'no query read the ballot status');
        assert.match(statusQuery, /JOIN\s+index_statuses\b/);
        assert.match(statusQuery, /COALESCE\(s1\.status,\s*'valid'\)\s+AS\s+status/);
    });

    it('preserves an explicit status stored on the ballot rows', async function () {
        const db = makeDb([
            ['vote_delegations', [BALLOT_MAIN_ROW]],
            ['FROM votes WHERE', BALLOT_CHOICE_ROWS],
            ['index_statuses s1', [{ status: 'invalid' }]]
        ]);
        const data = await db.getActionData(config, BALLOT);
        assert.strictEqual(data.status, 'invalid');
    });

    it('leaves status null when no ballot choice row exists', async function () {
        const db = makeDb([
            ['vote_delegations', [BALLOT_MAIN_ROW]]
        ]);
        const data = await db.getActionData(config, BALLOT);
        assert.strictEqual(data.vote_kind, 'ballot');
        assert.strictEqual(data.status, null);
        assert.deepStrictEqual(data.ballot, []);
    });
});

describe('VOTE v1 ballot status in lists @regression', function () {
    it('selects and renders the ballot row status', async function () {
        const db = makeDb([]);
        const [query] = await db.getVotes({
            data: {
                sql: {
                    where:  { data: 'm.action_index IS NOT NULL', offset: '' },
                    order:  'DESC',
                    limit:  10
                }
            }
        });
        assert.match(query, /JOIN\s+index_statuses\s+s1\s+ON\s*\(s1\.id=m\.status_id\)/);
        assert.match(query, /COALESCE\(s1\.status,\s*'valid'\)\s+AS\s+status/);

        const row = explorerRow(db.util, {
            ...BALLOT_MAIN_ROW,
            poll_index: POLL,
            choice:     0,
            share:      '1',
            status:     'valid'
        }, {
            type:          'explorer',
            method:        'getVotes',
            count:         1,
            count_reverse: 1,
            cfg:           {}
        });
        assert.strictEqual(row.at(-2), 1, 'the votes list must render the ballot as valid');
    });
});
