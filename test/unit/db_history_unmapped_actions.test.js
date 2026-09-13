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
 * The "All Activity" feed and the per-block action list must show EVERY action,
 * including the ones that move no ledger entry.
 *
 * mappings_actions is an address/tick LOOKUP INDEX: the indexer writes it from
 * the addresses/tickers an action touched, so an action that credits and debits
 * nobody - ANCHOR, PRICE, ATTEST, NODEPROOF, ROLLCALL and every future consensus
 * action - has no row in it at all. getHistoryData drove every variant of the
 * feed off that table, which made those actions structurally unreachable: on a
 * network whose traffic is all consensus actions (a testnet publishing PRICE
 * rounds and ANCHOR checkpoints) both the homepage feed and the block page
 * answered EMPTY while /anchors and /prices listed the very same actions.
 *
 * The fix keeps mappings_actions where its lookup is the point (type=address,
 * type=token) and reads `actions` directly everywhere else. These tests pin the
 * table each variant is driven by, and that the WHERE anchor getQueryWhereSql
 * emits names the matching alias - the two must agree or the query does not run.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

// Build the history config the way processRequest does, running the REAL
// getQueryWhereSql so the WHERE anchor under test is the shipped one rather
// than a hand-written string that cannot drift with it.
async function makeHistoryConfig(db, type, search, extras = {}) {
    const config = makeConfig({
        data: {
            method: 'getHistory',
            search,
            type,
            sql: { order: 'DESC', limit: 100, where: { data: '', offset: '' } },
            query: {},
            ...extras
        }
    });
    config.data.sql.where.data = await db.getQueryWhereSql(config);
    return config;
}

// Run getHistoryData against a stubbed doQuery and hand back the two SQL
// statements it built.
async function capture(db, config, rows = []) {
    let countQuery = null;
    let listQuery  = null;
    let countArgs  = null;
    let listArgs   = null;
    sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
        if(q && q.includes('count(DISTINCT')){ countQuery = q; countArgs = a; return [{ count: rows.length || 1 }]; }
        // The full-history shortcut probes for the highest action_index first.
        if(q && q.includes('ORDER BY action_index DESC')) return [];
        listQuery = q; listArgs = a;
        return rows;
    });
    sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
    const result = await db.getHistoryData(config);
    return { countQuery, listQuery, countArgs, listArgs, result };
}

// The table the statement's OUTER FROM clause drives off. Read from the LAST
// `FROM` in the text, not the first: the list query carries a correlated
// subquery (`... FROM actions apx INNER JOIN batches ...`) in its SELECT list,
// so the first FROM in the string belongs to the subquery and always says
// `actions` regardless of what the outer query reads.
function drivingTable(sql) {
    const all = [...String(sql).matchAll(/FROM\s+([a-z_]+)\s/gi)];
    return all.length ? all[all.length - 1][1] : null;
}

describe('db.getHistoryData: the all-activity feed is not gated on mappings_actions', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('[REGRESSION] the recent (homepage) feed reads `actions`, not mappings_actions', async () => {
        const config = await makeHistoryConfig(db, 'recent', 'null');
        const { countQuery, listQuery } = await capture(db, config);
        expect(drivingTable(listQuery)).to.equal('actions');
        expect(drivingTable(countQuery)).to.equal('actions');
        // An action with no address/tick mapping must not be filtered out by a
        // join it can never satisfy.
        expect(listQuery).to.not.include('mappings_actions');
        expect(countQuery).to.not.include('mappings_actions');
    });

    it('[REGRESSION] the per-block action list reads `actions`, not mappings_actions', async () => {
        // The block carrying only an ANCHOR rendered as a block with no actions.
        const config = await makeHistoryConfig(db, 'block', '67860432');
        const { countQuery, listQuery } = await capture(db, config);
        expect(drivingTable(listQuery)).to.equal('actions');
        expect(listQuery).to.not.include('mappings_actions');
        expect(countQuery).to.not.include('mappings_actions');
        // Still scoped to the one block.
        expect(listQuery).to.include('b1.block_index=?');
    });

    it('a list-all request with no type reads `actions` too', async () => {
        const config = await makeHistoryConfig(db, null, null);
        const { listQuery } = await capture(db, config);
        expect(drivingTable(listQuery)).to.equal('actions');
    });

    it('the address feed still drives off mappings_actions, which is what scopes it', async () => {
        sinon.stub(db, 'getAddressId').resolves(7);
        const config = await makeHistoryConfig(db, 'address', 'mvjQhFjE1RUaX2UQQAEgAYt51vtZDu7iNJ');
        const { countQuery, listQuery } = await capture(db, config);
        expect(drivingTable(listQuery)).to.equal('mappings_actions');
        expect(drivingTable(countQuery)).to.equal('mappings_actions');
        expect(listQuery).to.include('m.type_id=2');
    });

    it('the token feed still drives off mappings_actions', async () => {
        sinon.stub(db, 'getTickId').resolves(3);
        const config = await makeHistoryConfig(db, 'token', 'XCHAIN');
        const { listQuery } = await capture(db, config);
        expect(drivingTable(listQuery)).to.equal('mappings_actions');
        expect(listQuery).to.include('m.type_id=1');
    });

    it('the WHERE anchor names the alias its own FROM clause defines', async () => {
        // The anchor and the FROM clause are built in two different methods
        // (getQueryWhereSql / getHistoryData). If they disagree on the alias the
        // statement is not merely wrong, it does not parse.
        for(const [type, search, alias] of [
            ['recent',  'null',   'a1'],
            ['block',   '500',    'a1'],
            [null,      null,     'a1'],
            ['address', 'addr1',  'm'],
            ['token',   'XCHAIN', 'm']
        ]){
            sinon.stub(db, 'getAddressId').resolves(1);
            sinon.stub(db, 'getTickId').resolves(1);
            const config = await makeHistoryConfig(db, type, search);
            expect(config.data.sql.where.data, type + ' anchor').to.include(alias + '.action_index IS NOT NULL');
            sinon.restore();
        }
    });

    it('paging on the unmapped feed cursors on the same alias it selects', async () => {
        // ORDER BY, the DISTINCT cursor and the prev/next offset predicate all
        // have to name one column; a mismatch pages the wrong list or fails to parse.
        const config = await makeHistoryConfig(db, 'recent', 'null');
        config.data.offset = { action: 'next', start: '50', stop: null };
        const { listQuery, listArgs } = await capture(db, config);
        expect(listQuery).to.include('DISTINCT(a1.action_index)');
        expect(listQuery).to.include('ORDER BY a1.action_index');
        expect(listQuery).to.include('a1.action_index < ?');
        expect(listQuery).to.not.include('m.action_index');
        // The only bind is the cursor: type=recent contributes no data-WHERE placeholder.
        expect(listArgs).to.deep.equal(['50']);
    });

    it('paging backwards on the unmapped feed uses the same alias', async () => {
        const config = await makeHistoryConfig(db, 'recent', 'null');
        config.data.offset = { action: 'prev', start: '50', stop: null };
        const { listQuery } = await capture(db, config);
        expect(listQuery).to.include('a1.action_index > ?');
    });

    it('the block feed binds its block_index ahead of the paging cursor', async () => {
        const config = await makeHistoryConfig(db, 'block', '500');
        config.data.offset = { action: 'next', start: '50', stop: null };
        const { listArgs } = await capture(db, config);
        expect(listArgs).to.deep.equal(['500', '50']);
    });

    // getQueryOffsets resolves the CURSOR getHistoryData then pages on, in its own
    // queries against its own FROM clause. It had the identical bug, and it is the
    // more damaging half: with the list fixed but the boundary still computed over
    // mappings_actions, `action=first` (what the browser sends on every first page)
    // resolved to the newest LEDGER-MOVING action and the feed opened below every
    // consensus action newer than it - showing a correct total over a truncated list.
    it('[REGRESSION] the first-page boundary for the recent feed is computed over `actions`', async () => {
        let boundaryQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { boundaryQuery = q; return []; });
        const config = makeConfig({ data: {
            method: 'getHistory', search: null, type: 'recent',
            offset: { action: 'first', start: null, stop: null }
        }});
        await db.getQueryOffsets(config, false, 10);
        expect(boundaryQuery).to.not.equal(null);
        expect(boundaryQuery).to.not.include('mappings_actions');
        expect(boundaryQuery).to.include('a1.action_index as offset_index');
        expect(boundaryQuery).to.include('ORDER BY a1.action_index');
    });

    it('[REGRESSION] the first-page boundary for a block feed is computed over `actions`', async () => {
        let boundaryQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { boundaryQuery = q; return []; });
        const config = makeConfig({ data: {
            method: 'getHistory', search: '230', type: 'block',
            offset: { action: 'first', start: null, stop: null }
        }});
        await db.getQueryOffsets(config, false, 10);
        expect(boundaryQuery).to.not.include('mappings_actions');
        expect(boundaryQuery).to.include('b1.block_index=?');
    });

    it('the address-feed boundary still reads mappings_actions, which is its filter', async () => {
        let boundaryQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('index_addresses')) return [{ id: 7 }];
            boundaryQuery = q; return [];
        });
        const config = makeConfig({ data: {
            method: 'getHistory', search: 'addr1', type: 'address',
            offset: { action: 'first', start: null, stop: null }
        }});
        await db.getQueryOffsets(config, false, 10);
        expect(boundaryQuery).to.include('mappings_actions');
        expect(boundaryQuery).to.include('m.type_id=2');
    });

    it('the stop-marker query cursors on the same alias its FROM clause defines', async () => {
        const seen = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { seen.push(q); return []; });
        const config = makeConfig({ data: {
            method: 'getHistory', search: null, type: 'recent',
            offset: { action: 'next', start: 50, stop: null }
        }});
        await db.getQueryOffsets(config, 50, 10);
        const stop = seen.find((q) => q.includes('offset_index'));
        expect(stop).to.include('a1.action_index < ?');
        expect(stop).to.not.include('m.action_index');
        // blocks joined on the ACTION's own height, transactions LEFT-joined, so a
        // chain-generated action with no transaction row is not silently dropped
        // from the boundary while the list keeps it.
        expect(stop).to.include('INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)');
        expect(stop).to.match(/LEFT\s+JOIN transactions/);
    });

    it('returns the rows a consensus-only network produces', async () => {
        // The end state the whole change exists for: a feed whose every action is
        // a consensus action comes back populated, not empty.
        const config = await makeHistoryConfig(db, 'recent', 'null');
        const rows = [
            { action_index: 71, action: 'ANCHOR', block_index: 67860432, timestamp: 1788131485, tx_hash: 'h1', tx_index: 71, parent_batch_action_index: null },
            { action_index: 67, action: 'PRICE',  block_index: 67860332, timestamp: 1788127143, tx_hash: 'h2', tx_index: 67, parent_batch_action_index: null }
        ];
        const { result } = await capture(db, config, rows);
        const [data, total] = result;
        expect(data.map((r) => r.action)).to.deep.equal(['ANCHOR', 'PRICE']);
        expect(total).to.equal(2);
    });
});
