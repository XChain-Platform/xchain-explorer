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

const assert = require('assert');

const {
    VOTE_CLAUSE_BUILDERS
} = require('../../../../src/db/query_sql/where_vote_clauses.js');

const TYPE_CASES = {
    getPolls: [
        ['block', ' AND b1.block_index=?'],
        ['tick', ' AND pt.tick=?'],
        ['status', ' AND m.poll_status=?'],
        ['source', ' AND a2.address=?']
    ],
    getVotes: [
        ['address', ' AND a2.address=?'],
        ['poll', ' AND m.poll_index=?'],
        ['block', ' AND b1.block_index=?']
    ],
    getVoteDelegations: [
        ['tick', ' AND t3.tick=?'],
        ['delegator', ' AND dgr.address=?'],
        ['delegate', ' AND dg.address=?'],
        ['block', ' AND b1.block_index=?']
    ],
    getBetFeeds: [
        ['block', ' AND b1.block_index=?'],
        ['token', ' AND pt.tick=?'],
        ['status', ' AND fs.status=?'],
        ['source', ' AND a2.address=?'],
        ['address', ' AND a2.address=?']
    ],
    getBets: [
        ['address', ' AND a2.address=?'],
        ['feed', ' AND m.feed_action_index=?'],
        ['token', ' AND pt.tick=?'],
        ['status', ' AND bs.status=?'],
        ['block', ' AND b1.block_index=?']
    ]
};

const UNCONDITIONAL_CASES = {
    getPoll: ' AND m.action_index=?',
    getPollResults: ' AND m.poll_index=?',
    getBetFeed: ' AND m.action_index=?'
};

function build(method, type, sql = 'WHERE anchor') {
    const db = {};
    return VOTE_CLAUSE_BUILDERS[method](db, { data: { type } }, sql);
}

describe('VOTE_CLAUSE_BUILDERS', function(){
    it('exports exactly the vote and bet query builders', function(){
        const expected = [
            'getPolls', 'getPoll', 'getPollResults', 'getVotes',
            'getVoteDelegations', 'getBetFeeds', 'getBetFeed', 'getBets'
        ];

        assert.deepStrictEqual(Object.keys(VOTE_CLAUSE_BUILDERS).sort(), expected.sort());
    });

    for (const [method, cases] of Object.entries(TYPE_CASES)) {
        it(`${method} appends only the fragment selected by type`, function(){
            for (const [type, fragment] of cases)
                assert.strictEqual(build(method, type), `WHERE anchor${fragment}`);

            assert.strictEqual(build(method, 'unknown'), 'WHERE anchor');
        });
    }

    for (const [method, fragment] of Object.entries(UNCONDITIONAL_CASES)) {
        it(`${method} appends its identifier fragment for every type`, function(){
            assert.strictEqual(build(method, 'known'), `WHERE anchor${fragment}`);
            assert.strictEqual(build(method, 'unknown'), `WHERE anchor${fragment}`);
        });
    }
});
