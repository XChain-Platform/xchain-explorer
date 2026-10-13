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
 **********************************************************************
 * Unit tests for pruneCountJoins (src/db/query_sql/count_joins.js).
 *
 * Pins the exact pruned COUNT for the list lanes the readers build, and every
 * shape the pruner must leave untouched: a join a filter needs, an INNER join,
 * a LEFT join on a non-unique key, a placeholder in an ON, a subquery or an
 * unqualified column in the WHERE, and any FROM it cannot parse.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { pruneCountJoins, parseCountSql } = require('../../../../src/db/query_sql/count_joins.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ISSUES_BASE = 'SELECT count(*) as total FROM issues m ' +
    'INNER JOIN actions            a1 ON (a1.action_index=m.action_index) ' +
    'INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)';

let db;

function flat(sql){
    return sql.replace(/\s+/g, ' ').trim();
}

// The COUNT getQuery builds for one api request, before pruning.
async function countFor(method, type, query){
    const cfg = makeConfig({ coin: 'BTC', type: 'api',
        data: { method, type: type || null, search: type ? 'x' : null, query: query || {} } });
    return (await db.getQuery(cfg))[2];
}

async function prunedFor(method, type, query){
    return flat(pruneCountJoins(await countFor(method, type, query)));
}

describe('pruneCountJoins: list lanes', function(){
    beforeEach(function(){
        const configInfo = createConfigInfoStub();
        db = new Database({ configInfo, util: new Utility(configInfo) });
        db.doQuery = async () => [];
        db.getCanonicalTick = async (config, value) => value;
    });

    it('counts list-all issues over the base table and its two inner joins', async function(){
        expect(await prunedFor('getIssues')).to.equal(flat(ISSUES_BASE + ' WHERE m.action_index IS NOT NULL'));
    });

    it('keeps the address join and the transactions join its ON reads', async function(){
        expect(await prunedFor('getIssues', 'address')).to.equal(flat(ISSUES_BASE +
            ' LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)' +
            ' LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))' +
            ' WHERE m.action_index IS NOT NULL AND a2.address=?'));
    });

    it('keeps only the ticker join for the token lane', async function(){
        expect(await prunedFor('getIssues', 'token')).to.equal(flat(ISSUES_BASE +
            ' LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)' +
            ' WHERE m.action_index IS NOT NULL AND t3.tick=?'));
    });

    it('keeps the inner blocks join the block lane filters on', async function(){
        expect(await prunedFor('getIssues', 'block')).to.equal(flat(ISSUES_BASE +
            ' WHERE m.action_index IS NOT NULL AND b1.block_index=?'));
    });

    it('counts the raw action feed over actions and blocks only', async function(){
        expect(await prunedFor('getActions')).to.equal(flat('SELECT count(*) as total FROM actions m ' +
            'INNER JOIN blocks             b1 ON (b1.block_index=m.block_index) WHERE m.action_index IS NOT NULL'));
    });

    it('keeps the transaction chain a txid filter reaches through', async function(){
        expect(await prunedFor('getActions', null, { txid: 'ab' })).to.equal(flat('SELECT count(*) as total FROM actions m ' +
            'INNER JOIN blocks             b1 ON (b1.block_index=m.block_index) ' +
            'LEFT  JOIN transactions       t1 ON (t1.tx_index=m.tx_index) ' +
            'LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id) ' +
            'WHERE m.action_index IS NOT NULL AND t2.hash=?'));
    });

    it('keeps the DISTINCT count expression of a multi-leg table', async function(){
        expect(await prunedFor('getDestroys')).to.equal(flat('SELECT count(DISTINCT m.action_index) as total FROM destroys m ' +
            'INNER JOIN actions            a1 ON (a1.action_index=m.action_index) ' +
            'INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index) WHERE m.action_index IS NOT NULL'));
    });

    it('leaves the tick subquery lane of the action feed untouched', async function(){
        const count = await countFor('getActions', null, { tick: 'XCH' });
        expect(pruneCountJoins(count)).to.equal(count);
    });
});

describe('pruneCountJoins: shapes it must not prune', function(){
    const tail = ' WHERE m.action_index IS NOT NULL';

    it('returns the same string when every join is needed', function(){
        const sql = ISSUES_BASE + tail;
        expect(pruneCountJoins(sql)).to.equal(sql);
    });

    it('keeps an INNER join nothing else names, even on a unique key', function(){
        const sql = 'SELECT count(*) as total FROM sends m INNER JOIN index_memos m1 ON (m1.id=m.memo_id)' + tail;
        expect(pruneCountJoins(sql)).to.equal(sql);
    });

    it('keeps a LEFT join on a non-unique key', function(){
        const sql = 'SELECT count(*) as total FROM files m LEFT JOIN blocks b2 ON (b2.block_index=m.block_index)' +
            ' LEFT JOIN gated_files gf ON (gf.action_index=m.action_index)' + tail;
        expect(pruneCountJoins(sql)).to.equal(sql);
    });

    it('keeps a unique-key join whose ON is written the other way round or carries a second term', function(){
        const reversed = 'SELECT count(*) as total FROM sends m LEFT JOIN index_memos m1 ON (m.memo_id=m1.id)' + tail;
        const twoTerms = 'SELECT count(*) as total FROM sends m LEFT JOIN index_memos m1 ON (m1.id=m.memo_id AND m1.id>0)' + tail;
        expect(pruneCountJoins(reversed)).to.equal(reversed);
        expect(pruneCountJoins(twoTerms)).to.equal(twoTerms);
    });

    it('keeps a join whose ON binds a placeholder, so the args stay aligned', function(){
        const sql = 'SELECT count(*) as total FROM sends m LEFT JOIN index_memos m1 ON (m1.id=COALESCE(m.memo_id, ?))' + tail;
        expect(pruneCountJoins(sql)).to.equal(sql);
    });

    it('keeps every join when the WHERE holds a subquery or an unqualified column', function(){
        const join = 'SELECT count(*) as total FROM dispensers m LEFT JOIN index_memos m1 ON (m1.id=m.memo_id) WHERE ';
        const sub  = join + 'm.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)';
        const bare = join + 'memo=?';
        expect(pruneCountJoins(sub)).to.equal(sub);
        expect(pruneCountJoins(bare)).to.equal(bare);
    });

    it('does not mistake SQL words or qualified columns for unqualified ones', function(){
        const sql = 'SELECT count(*) as total FROM sends m LEFT JOIN index_memos m1 ON (m1.id=m.memo_id)' +
            ' WHERE m.action_index IS NOT NULL AND m.tick_id NOT IN (1,2) AND COALESCE(m.amount, 0)=?';
        expect(flat(pruneCountJoins(sql))).to.equal(flat('SELECT count(*) as total FROM sends m' +
            ' WHERE m.action_index IS NOT NULL AND m.tick_id NOT IN (1,2) AND COALESCE(m.amount, 0)=?'));
    });

    it('leaves a derived table, a comma join or a non-count statement alone', function(){
        const derived = 'SELECT count(*) as total FROM (SELECT 1) m LEFT JOIN index_memos m1 ON (m1.id=m.x)' + tail;
        const comma   = 'SELECT count(*) as total FROM sends m, index_memos m1' + tail;
        const rows    = 'SELECT m.* FROM sends m LEFT JOIN index_memos m1 ON (m1.id=m.memo_id)' + tail;
        for(const sql of [derived, comma, rows])
            expect(pruneCountJoins(sql)).to.equal(sql);
        expect(parseCountSql(comma)).to.equal(null);
        expect(pruneCountJoins(undefined)).to.equal(undefined);
    });
});
