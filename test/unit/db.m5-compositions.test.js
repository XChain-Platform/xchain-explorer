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
 * Unit tests for the M5 data layer (spec explorer-coverage-completion rows
 * 32/33/35): getCollectibles' classification, getRichList's composition, and
 * the two XCALL phase reads behind the WS channel.
 *
 * The same builder-vs-composition split db.m4-compositions.test.js documents
 * applies here, and this file spans BOTH kinds, so it uses both idioms:
 *
 *  - getCollectibles is a BUILDER. It returns [query, args, count] and getData
 *    is the executor, so `doQuery.called` inside it is vacuous. What is pinned
 *    instead is the TEXT of the two queries it returns and, crucially, that the
 *    classification predicate reaches the COUNT query as well as the row query:
 *    a classification applied to only one of them pages a gallery whose total
 *    counts every token on the chain.
 *
 *  - getRichList, getXcallInfo and getXcallPhasesSince run their own reads and
 *    return values directly, so doQuery is stubbed and every query and arg
 *    array is captured.
 *
 * The properties these tests exist to protect, each of which is a way the
 * surface could be wrong while looking right:
 *
 *  1. A rich list that divides by MAX supply rather than circulating supply
 *     understates every holder's share, and the page would still render.
 *  2. A percentage that cannot be computed must come back null, never 0: a 0
 *     tells the reader the largest holder owns none of the token.
 *  3. Ranks must carry the page offset, or page 2 restarts at rank 1 and two
 *     different addresses both render as "#1 holder".
 *  4. The XCALL phase cursor must bind the VALID row only, and must carry both
 *     terminal statuses: a cursor that emits completions but not expiries makes
 *     a live timeline that silently stalls on every expired call.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// A deliberately NON-DEFAULT page bound, for the same reason the M4 file uses
// one: a method that hardcodes 100 looks correct against the default.
const LIMIT = 25;

function makeDb(){
    return new DatabaseReal({ configInfo, util, hubOperational: null });
}

function cfg(method, search, extras = {}){
    return makeConfig({
        coin: 'BTC',
        type: 'api',
        data: {
            method,
            search,
            type: null,
            sql: {
                order: 'DESC',
                limit: LIMIT,
                apiOffset: 0,
                where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

function flat(sql){
    return String(sql).replace(/\s+/g, ' ').trim();
}

function stubQueries(db, plan = []){
    db.doQuery = sinon.stub().callsFake(async (c, query) => {
        const f = flat(query);
        for(const [needle, rows] of plan)
            if(f.includes(needle)) return rows;
        return [];
    });
    return db;
}

/* ------------------------------------------------------------------ *
 * Row 32: getCollectibles - the classification
 * ------------------------------------------------------------------ */

describe('M5.1 getCollectibles classification (spec rows 32)', function () {

    // The WHERE fragment getQueryWhereSql builds for this method, which is what
    // both queries below are handed. Built through the real method rather than
    // restated, so the assertion cannot drift from the shipped rule.
    async function whereFor(type, search){
        const db = makeDb();
        return await db.getQueryWhereSql(cfg('getCollectibles', search, { type }));
    }

    it('classifies on the ISSUE fields, indivisible with a frozen ceiling', async function () {
        const where = await whereFor(null, null);
        expect(where).to.include('m.decimals=0');
        expect(where).to.include('m.lock_max_supply=1');
    });

    it('is the SAME rule the client ships as isNftToken, not a second definition', function () {
        // Two definitions of "collectible" that drift is the failure mode here: the
        // gallery would list tokens the token page refuses to badge, or the reverse.
        // The client's rule is read out of the shipped source rather than restated.
        const fs   = require('fs');
        const path = require('path');
        const src  = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
        const body = src.slice(src.indexOf('function isNftToken('));
        expect(body).to.include('Number(decimals)===0');
        expect(body).to.include('Number(lockMaxSupply)===1');
    });

    it('binds the classification to the COUNT query too, not only the row query', async function () {
        // The defect this prevents: a gallery paging over a `total` that counted
        // every token on the chain, so the pager offers pages that are always empty.
        const db = makeDb();
        const c  = cfg('getCollectibles', null);
        c.data.sql.where.data = await db.getQueryWhereSql(c);
        const [query, args, count] = await db.getCollectibles(c);
        expect(flat(count)).to.include('m.decimals=0 AND m.lock_max_supply=1');
        expect(flat(query)).to.include('m.decimals=0 AND m.lock_max_supply=1');
        expect(args).to.deep.equal([]);
    });

    it('interpolates the caller-clamped page bound rather than a hardcoded one', async function () {
        const db = makeDb();
        const c  = cfg('getCollectibles', null);
        c.data.sql.where.data = await db.getQueryWhereSql(c);
        const [query] = await db.getCollectibles(c);
        expect(flat(query)).to.include('LIMIT ' + LIMIT);
    });

    it('seeds the search arg on a filtered lane and NOT on the list-all lane', async function () {
        // getTokens documents the phantom-bind hazard: seeding [search] with no
        // QUERY/TYPE prepends an unbound placeholder that shifts the offset args.
        const db = makeDb();
        const listAll = cfg('getCollectibles', null);
        listAll.data.sql.where.data = await db.getQueryWhereSql(listAll);
        expect((await db.getCollectibles(listAll))[1]).to.deep.equal([]);

        const owned = cfg('getCollectibles', '1OwnerAddr', { type: 'address' });
        owned.data.sql.where.data = await db.getQueryWhereSql(owned);
        expect((await db.getCollectibles(owned))[1]).to.deep.equal(['1OwnerAddr']);
        expect(owned.data.sql.where.data).to.include('a2.address=?');
    });

    it('pages on m.id, the column it orders by', async function () {
        // The cursor column and the ORDER BY must agree or paging walks a
        // different sequence than the one on screen.
        const db = makeDb();
        const c  = cfg('getCollectibles', null, { offset: { action: 'next', start: 500 } });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(c);
        expect(offsetSql).to.include('m.id');
        expect(offsetArgs).to.deep.equal([500]);
        expect(db.cursorPagedMethods).to.include('getCollectibles');
    });
});

/* ------------------------------------------------------------------ *
 * Row 33: getRichList
 * ------------------------------------------------------------------ */

describe('M5.2 getRichList (spec row 33)', function () {

    const TICK = 'RARETOKEN';

    const TOKEN_ROW = {
        tick: TICK, supply: '1000', max_supply: '5000', max_mint: null, decimals: 0,
        lock_max_supply: 1, lock_mint: 0, description: 'a thing', owner: '1Owner',
        action_index: 90, block_index: 800
    };

    function plan(overrides = {}){
        return [
            ['FROM index_tickers WHERE tick=?', overrides.tick   || [{ id: 7 }]],
            ['FROM tokens m',                   overrides.token  || [TOKEN_ROW]],
            ['count(*) as holder_count',        overrides.census || [{ holder_count: 3, held_total: '1000' }]],
            ['FROM balances m LEFT JOIN index_addresses', overrides.holders || [
                { address: '1Whale', amount: '600' },
                { address: '1Mid',   amount: '300' },
                { address: '1Small', amount: '100' }
            ]]
        ];
    }

    async function run(overrides = {}, extras = {}){
        const db = stubQueries(makeDb(), plan(overrides));
        const [data] = await db.getRichList(cfg('getRichList', TICK, extras));
        return { db, data };
    }

    it('resolves the tick to an id FIRST and binds the id, never the tick, to balances', async function () {
        // getHolders binds t3.tick through a LEFT JOIN and needs its own existence
        // guard to avoid a full balances scan (a DoS-shaped hang is on record).
        // Resolving to the indexed tick_id first removes that failure mode.
        const { db } = await run();
        const balanceQueries = db.doQuery.getCalls()
            .map((c) => flat(c.args[1]))
            .filter((q) => q.includes('FROM balances m'));
        expect(balanceQueries.length).to.be.greaterThan(0);
        for(const q of balanceQueries){
            expect(q).to.include('m.tick_id=?');
            expect(q).to.not.include('t3.tick=?');
        }
        for(const c of db.doQuery.getCalls().filter((x) => flat(x.args[1]).includes('FROM balances m')))
            expect(c.args[2][0]).to.equal(7);
    });

    it('answers not-found for a tick that was never interned', async function () {
        const { data, db } = await run({ tick: [] });
        expect(data).to.equal(null);
        // and it stops there rather than composing around nulls
        expect(db.doQuery.getCalls().some((c) => flat(c.args[1]).includes('FROM balances m'))).to.equal(false);
    });

    it('answers not-found for an interned tick with no token row', async function () {
        // A tick can be interned by a REFERENCE (an ORDER naming a tick nobody
        // issued), so an id is not proof that a token exists.
        const { data } = await run({ token: [] });
        expect(data).to.equal(null);
    });

    it('measures share against CIRCULATING supply, not max supply', async function () {
        // 600 of a 1000 circulating supply is 60%. Against the 5000 max supply it
        // would read 12%, which is the quiet way a rich list understates a whale.
        const { data } = await run();
        expect(data.holders[0].percent).to.equal('60.00000000');
    });

    it('excludes zero balances from both the census and the ranking', async function () {
        const { db } = await run();
        const balanceQueries = db.doQuery.getCalls()
            .map((c) => flat(c.args[1]))
            .filter((q) => q.includes('FROM balances m'));
        expect(balanceQueries.length).to.equal(2);
        for(const q of balanceQueries)
            expect(q).to.include("CAST(m.amount AS DECIMAL(65,18)) > 0");
    });

    it('carries the summed balances ALONGSIDE the recorded supply rather than replacing it', async function () {
        // A disagreement between the two is an indexer symptom. Substituting
        // whichever number makes the percentages total 100 erases the evidence.
        const { data } = await run({ census: [{ holder_count: 3, held_total: '900' }] });
        expect(data.supply).to.equal('1000');
        expect(data.held_total).to.equal('900');
    });

    it('returns null, never 0, for a share it cannot compute', async function () {
        const { data } = await run({ token: [Object.assign({}, TOKEN_ROW, { supply: '0' })] });
        expect(data.holders[0].percent).to.equal(null);
        expect(data.top_holder_percent).to.equal(null);
    });

    it('leaves the top-ten concentration UNMEASURED below ten ranked holders', async function () {
        // Null, not 0: "we did not measure this" must not read as "the top ten
        // hold nothing".
        const { data } = await run();
        expect(data.ranked_count).to.equal(3);
        expect(data.top_ten_percent).to.equal(null);
    });

    it('measures the top-ten concentration once ten holders are ranked', async function () {
        const holders = [];
        for(let i = 0; i < 12; i++) holders.push({ address: '1H' + i, amount: '50' });
        const { data } = await run({
            holders,
            census: [{ holder_count: 12, held_total: '600' }]
        });
        // Ten holders at 50 each = 500 of a 1000 supply.
        expect(data.top_ten_percent).to.equal('50.00000000');
    });

    it('continues the rank numbering across pages instead of restarting at 1', async function () {
        // Page 2 restarting at rank 1 renders two different addresses as "#1 holder".
        const { data } = await run({}, { sql: {
            order: 'DESC', limit: LIMIT, apiOffset: 100,
            where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
        } });
        expect(data.holders.map((h) => h.rank)).to.deep.equal([101, 102, 103]);
    });

    it('bounds the ranking with the caller-clamped limit', async function () {
        const { db } = await run();
        const ranking = db.doQuery.getCalls()
            .map((c) => flat(c.args[1]))
            .find((q) => q.includes('ORDER BY CAST(m.amount AS DECIMAL(65,18)) DESC'));
        expect(ranking).to.include('LIMIT ' + LIMIT);
    });

    it('survives a malformed amount instead of failing the whole page', async function () {
        // Both figures come from VARCHAR columns and mathjs THROWS on junk. A rich
        // list that 500s because one row is corrupt is worse than one missing a
        // single percentage.
        const { data } = await run({ holders: [
            { address: '1Whale', amount: '600' },
            { address: '1Junk',  amount: 'not-a-number' }
        ] });
        expect(data.holders[0].percent).to.equal('60.00000000');
        expect(data.holders[1].percent).to.equal(null);
    });
});

/* ------------------------------------------------------------------ *
 * Row 35: the XCALL phase reads behind the WS channel
 * ------------------------------------------------------------------ */

describe('M5.4 XCALL phase reads (spec row 35)', function () {

    const CALL = 'c'.repeat(64);

    it('cursors on resolved_block, the height with no action row behind it', async function () {
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 900, 50);
        const q = flat(db.doQuery.firstCall.args[1]);
        expect(q).to.include('m.resolved_block > ?');
        expect(q).to.include('ORDER BY m.resolved_block ASC');
        expect(db.doQuery.firstCall.args[2]).to.deep.equal([900, 50]);
    });

    it('carries BOTH terminal statuses, so expiries are not silently dropped', async function () {
        // A cursor that emits completions but not expiries makes a live timeline
        // that stalls forever on every call that timed out.
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 0, 10);
        expect(flat(db.doQuery.firstCall.args[1]))
            .to.include("m.request_status IN ('completed','expired')");
    });

    it('binds the VALID row only, matching the indexer authoritative read', async function () {
        // A call_id can carry more than one xcalls row; an invalid one shadowing
        // the real request is the defect row 56 fixed on the detail path.
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 0, 10);
        expect(flat(db.doQuery.firstCall.args[1])).to.include("s1.status='valid'");
    });

    it('getXcallInfo point-reads one call by id, valid row only, bounded to one row', async function () {
        const db = stubQueries(makeDb(), [['FROM xcalls m', [{ call_id: CALL, request_status: 'pending' }]]]);
        const row = await db.getXcallInfo({ coin: 'BTC' }, CALL);
        expect(row.call_id).to.equal(CALL);
        const q = flat(db.doQuery.firstCall.args[1]);
        expect(q).to.include('m.call_id=?');
        expect(q).to.include("s1.status='valid'");
        expect(q).to.include('LIMIT 1');
        expect(db.doQuery.firstCall.args[2]).to.deep.equal([CALL]);
    });

    it('getXcallInfo answers null for a call this chain has no row for', async function () {
        // The normal answer on the TARGET chain of a call, not an error.
        const db = stubQueries(makeDb(), []);
        expect(await db.getXcallInfo({ coin: 'BTC' }, CALL)).to.equal(null);
    });
});
