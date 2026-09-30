/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const PollReaders = require('../../../../../src/db/readers/polls_bets/polls.js');
const BetReaders = require('../../../../../src/db/readers/polls_bets/bets.js');
const governanceSql = require('../../../../../src/db/action_detail/governance_sql.js');
const governance = require('../../../../../src/action-detail/governance.js');
const { voteAndBetRows, crossChainRows } = require('../../../../../src/explorer/paging/feed_rows.js');

const config = { data: { sql: { where: { data: '1=1', offset: '' }, order: 'DESC', limit: 10 } } };
const util = { isNull: value => value === null || value === undefined || value === '' };

describe('governance feeds carry parent option labels', function () {
    it('joins each ballot to its poll options and shapes the selected label', async function () {
        const [query] = await PollReaders.getVotes(config);
        assert.match(query, /LEFT\s+JOIN polls\s+p\s+ON \(p\.action_index=m\.poll_index\)/);
        assert.match(query, /p\.options as poll_options/);
        const row = voteAndBetRows({ poll_index: 9, choice: 1, share: 40,
            poll_options: '["YES","NO"]', action_index: 10 }, {
            count_reverse: 1, status: 1, method: 'getVotes', util
        });
        assert.strictEqual(row[6], 'NO');
    });

    it('joins each wager to its market outcomes and shapes the selected label', async function () {
        const [query] = await BetReaders.getBets(config);
        assert.match(query, /LEFT\s+JOIN bet_feeds\s+f\s+ON \(f\.action_index=m\.feed_action_index\)/);
        assert.match(query, /f\.outcomes/);
        const row = crossChainRows({ feed_action_index: 7, outcome: 0,
            outcomes: 'Chiefs,49ers', action_index: 10 }, {
            count_reverse: 1, status: 1, method: 'getBets'
        });
        assert.strictEqual(row[6], 'Chiefs');
    });
});

describe('governance action detail carries parent option labels', function () {
    it('left joins BET legs to the parent feed so missing parents remain tolerated', function () {
        assert.match(governanceSql.BET_DETAIL,
            /LEFT\s+JOIN bet_feeds\s+pf\s+ON \(pf\.action_index=COALESCE\(/);
        assert.match(governanceSql.BET_DETAIL, /COALESCE\(f\.outcomes, pf\.outcomes\) as outcomes/);
    });

    it('left joins VOTE ballot choices to the parent poll options', function () {
        assert.match(governanceSql.VOTE_BALLOT_CHOICES,
            /LEFT JOIN polls p ON \(p\.action_index=v\.poll_index\)/);
        assert.match(governanceSql.VOTE_BALLOT_CHOICES, /p\.options as poll_options/);
    });

    it('attaches a parent outcome label to wager and resolve detail payloads', async function () {
        const db = { util, doQuery: async () => [] };
        const wager = { action_format: 2, feed_action_index: 7, outcome: 1,
            outcomes: 'Chiefs,49ers' };
        await governance.BET.afterMain({ db, config: {}, action_index: 10 }, wager);
        assert.deepStrictEqual(wager.outcome_labels, ['Chiefs', '49ers']);
    });

    it('attaches a parent option label to each ballot choice', async function () {
        let call = 0;
        const db = { util, doQuery: async () => (++call === 1
            ? [{ poll_index: 9, choice: 1, share: 40, memo: null, poll_options: '["YES","NO"]' }]
            : [{ status: 'valid' }]) };
        const ballot = { action_format: 1, poll_status: null, delegator: null };
        await governance.VOTE.afterMain({ db, config: {}, action_index: 10 }, ballot);
        assert.deepStrictEqual(ballot.ballot,
            [{ choice: 1, label: 'NO', share: 40 }]);
    });
});
