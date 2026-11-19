/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert/strict');

const { REGISTRY } = require('../../../src/action-detail');
const sources = require('../../../src/db/readers/checkpoints/sources.js');
const PollReaders = require('../../../src/db/readers/polls_bets/polls.js');
const { VOTE_CLAUSE_BUILDERS } = require('../../../src/db/query_sql/where_vote_clauses.js');

function voteCtx(){
    return { action_index: 9, config: {}, db: { util: { isNull: v => v === null || v === undefined },
        async doQuery(){ return []; } } };
}

function bridgeCtx(rows){
    return { action_index: 4242, config: { coin: 'DOGE' }, db: {
        checkpointDb: { DOGE: { name: 'hub', chain: 'DOGE', network: 'mainnet' } },
        bridgeTransferSource: sources.bridgeTransferSource,
        async doQuery(config, sql){
            return /information_schema\.TABLES/i.test(sql) ? [{ TABLE_NAME: 'bridge_settlements' }] : rows;
        } } };
}

describe('refused actions are not reported as live @regression', function () {
    it('reports a poll row whose create was refused as refused, not open', async function () {
        const data = { poll_status: 'open', status: 'invalid: bad options', options: '[]' };
        await REGISTRY.VOTE.afterMain(voteCtx(), data);
        assert.equal(data.vote_kind, 'poll');
        assert.equal(data.poll_status, 'refused');
    });

    it('keeps the stored lifecycle of an accepted poll create', async function () {
        const data = { poll_status: 'open', status: 'valid', options: '["a","b"]' };
        await REGISTRY.VOTE.afterMain(voteCtx(), data);
        assert.equal(data.poll_status, 'open');
    });

    it('limits the lifecycle filter to creates that were accepted', function () {
        const sql = VOTE_CLAUSE_BUILDERS.getPolls({}, { data: { type: 'status' } }, '');
        assert.match(sql, /m\.poll_status=\?/);
        assert.match(sql, /COALESCE\(s1\.status, 'valid'\)='valid'/);
    });

    it('clears the in-flight claim on a refused broadcast of a system-injected XBRIDGE version', async function () {
        for(const format of [2, 5]){
            const data = { action_format: format, status: 'invalid: XBRIDGE v' + format + ' is system-injected' };
            await REGISTRY.XBRIDGE.afterMain(bridgeCtx([]), data);
            assert.equal(data.bridge_pending, false, 'format ' + format);
        }
    });

    it('clears the in-flight claim on a v2 or v5 refused before activation', async function () {
        for(const format of [2, 5]){
            const data = { action_format: format, status: 'invalid: XBRIDGE before activation' };
            await REGISTRY.XBRIDGE.afterMain(bridgeCtx([]), data);
            assert.equal(data.bridge_pending, false, 'format ' + format);
        }
    });

    it('still reports an accepted, not yet settled injected leg as in flight', async function () {
        const data = { action_format: 2, status: 'valid' };
        await REGISTRY.XBRIDGE.afterMain(bridgeCtx([]), data);
        assert.equal(data.bridge_pending, true);
    });
});

describe('poll readers report a refused create as refused @regression', function () {
    const CASE = /CASE WHEN COALESCE\(s1\.status, 'valid'\)='valid' THEN m\.poll_status ELSE 'refused' END AS poll_status/;
    const config = { data: { search: 9, sql: { where: { data: '1=1', offset: '' }, order: 'DESC', limit: 10 } } };

    it('projects the guarded lifecycle in the list query over a joined status', async function () {
        const [query, , count] = await PollReaders.getPolls(config);
        assert.match(query, CASE);
        assert.match(query, /LEFT\s+JOIN index_statuses\s+s1 ON \(s1\.id=m\.status_id\)/);
        assert.match(count, /LEFT\s+JOIN index_statuses\s+s1 ON \(s1\.id=m\.status_id\)/,
            'the count joins the status the status filter reads');
    });

    it('projects the guarded lifecycle on the single poll read', async function () {
        let sent = null;
        const reader = Object.assign(Object.create(PollReaders), { util: { isNull: v => v == null },
            async doQuery(cfg, query){ sent = query; return []; } });
        await reader.getPoll(config);
        assert.match(sent, CASE);
    });
});
