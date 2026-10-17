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
 * API keyset paging bound end to end through getData: ?before=/?after= reach
 * the SQL as one placeholder on the list's cursor column, in the place the
 * page's ORDER BY reads, with no OFFSET, whatever ?page= says. Every listed
 * method is driven on every route type it serves, so a reader that drops or
 * doubles sql.where.offset fails here rather than paging from the newest row.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');

const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { KEYSET_METHODS }       = require('../../../../../src/db/query_sql/keyset.js');
const { cursorField }          = require('../../../../../src/db/query_sql/offset_cursors.js');
const { api }                  = require('../../../../../src/explorer/routes/api_methods.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const SEARCH = {
    block: '950000', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', source: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    destination: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', token: 'TEST', tick: 'TEST', contract: '7', poll: '7',
    feed: '7', status: 'valid', name: 'word', gate: 'TEST', oracle: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    dispenser: '7', pubkey: 'ab'.repeat(33)
};

// One row that satisfies every lookup a reader makes before its list query.
const ROW = { id: 7, total: 3, count: 3, action_index: 499, block_index: 499, tick: 'TEST' };

function makeDb(calls) {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
    db.doQuery = async (config, sql, args) => {
        // A failing index probe reads as present, which opens the contracts name lane.
        if (sql.includes('information_schema.STATISTICS'))
            throw new Error('index probe unavailable');
        calls.push({ sql, args: args || [] });
        return [Object.assign({}, ROW)];
    };
    return db;
}

async function run(method, type, query) {
    const calls  = [];
    const db     = makeDb(calls);
    const config = makeConfig({ type: 'api', data: { method, type: type || null, search: type ? SEARCH[type] : null, query } });
    await db.getData(config);
    return { calls, config };
}

function placeholders(sql) {
    return (sql.match(/\?/g) || []).length;
}

// The statement carrying `pred`, and the bind value at that predicate's placeholder.
function boundAt(calls, pred) {
    const hits = calls.filter((c) => c.sql.includes(pred));
    expect(hits, 'statements carrying ' + pred).to.have.length.greaterThan(0);
    return hits.map((c) => {
        expect(c.sql.split(pred).length - 1, 'predicate appears once').to.equal(1);
        expect(placeholders(c.sql), 'placeholders match args').to.equal(c.args.length);
        const at = placeholders(c.sql.slice(0, c.sql.indexOf(pred)));
        return { sql: c.sql, value: c.args[at] };
    });
}

// Every route type each listed method serves, plus its list-all form.
function routeCases() {
    const cases = [];
    for (const [path, [method, types]] of Object.entries(api)) {
        if (!KEYSET_METHODS.has(method) || method == 'getHistory')
            continue;
        if (!path.includes('{TYPE}'))
            cases.push([method, null]);
        else
            for (const type of [].concat(types))
                cases.push([method, type]);
    }
    return cases;
}

describe('API keyset paging: every listed method binds before= as one cursor placeholder', function () {
    for (const [method, type] of routeCases()) {
        it(method + ' ' + (type || 'list-all'), async function () {
            const { calls, config } = await run(method, type, { before: '500', page: '101' });
            const pred = ' AND ' + cursorField(method) + ' < ?';
            for (const hit of boundAt(calls, pred)) {
                expect(hit.value).to.equal(500);
                expect(hit.sql).to.not.match(/\bOFFSET\b/);
                // The issues ids leg drives from actions and orders on a1, the same value.
                const column = cursorField(method).replace(/^m\./, '(m|a1)\\.');
                expect(hit.sql).to.match(new RegExp('ORDER BY\\s+' + column + '\\s+DESC'));
            }
            expect(config.data.sql.apiOffset).to.equal(0);
            for (const c of calls.filter((x) => /count\(/i.test(x.sql)))
                expect(c.sql, 'the count is not bounded by the cursor').to.not.include(pred);
        });
    }
});

describe('API keyset paging: history, issues and commitments', function () {
    for (const [type, cursor] of [['address', 'm.action_index'], ['token', 'm.action_index'],
        ['block', 'a1.action_index'], ['recent', 'a1.action_index']]) {
        it('history ' + type + ' bounds the ids leg on ' + cursor + ' and not the count', async function () {
            const { calls } = await run('getHistory', type, { before: '500', page: '101' });
            const [hit] = boundAt(calls, ' AND ' + cursor + ' < ?');
            expect(hit.value).to.equal(500);
            expect(hit.sql).to.match(/LIMIT 100$/);
            expect(hit.sql).to.include('ORDER BY ' + cursor + ' DESC');
            const count = calls.find((c) => /count\(\*\)/.test(c.sql));
            expect(count.sql).to.not.include(' < ?');
        });
    }

    it('history after= pages up from the cursor in the requested order', async function () {
        const { calls } = await run('getHistory', 'address', { after: '500', sortorder: 'asc' });
        const [hit] = boundAt(calls, ' AND m.action_index > ?');
        expect(hit.value).to.equal(500);
        expect(hit.sql).to.include('ORDER BY m.action_index ASC');
    });

    it('issues: the ids leg carries the cursor, the rows leg decorates only the ids it picked', async function () {
        const { calls } = await run('getIssues', 'address', { before: '500', page: '101' });
        const [ids] = boundAt(calls, ' AND m.action_index < ?');
        expect(ids.value).to.equal(500);
        expect(ids.sql).to.match(/^SELECT (STRAIGHT_JOIN )?\w+\.action_index as action_index/);
        const rows = calls.find((c) => /action_index IN \(\?\)/.test(c.sql));
        expect(rows.args).to.deep.equal([499]);
    });

    it('commitments: the block_index cursor binds inside the derived page, ahead of the join placeholders', async function () {
        const { calls } = await run('getCommitments', null, { before: '950000', page: '101' });
        const [hit] = boundAt(calls, ' AND m.block_index < ?');
        expect(hit.value).to.equal(950000);
        expect(hit.sql.indexOf('m.block_index < ?')).to.be.lessThan(hit.sql.indexOf('LEFT JOIN'));
        expect(hit.sql).to.not.match(/OFFSET/);
    });

});

describe('API keyset paging: history, issues and commitments (continued)', function () {
    for (const [type, cursor] of [['address', 'm.action_index'], ['token', 'm.action_index'],
        ['block', 'a1.action_index'], ['recent', 'a1.action_index']]) {
        it('history ' + type + ' bounds the ids leg on ' + cursor + ' and not the count', async function () {
            const { calls } = await run('getHistory', type, { before: '500', page: '101' });
            const [hit] = boundAt(calls, ' AND ' + cursor + ' < ?');
            expect(hit.value).to.equal(500);
            expect(hit.sql).to.match(/LIMIT 100$/);
            expect(hit.sql).to.include('ORDER BY ' + cursor + ' DESC');
            const count = calls.find((c) => /count\(\*\)/.test(c.sql));
            expect(count.sql).to.not.include(' < ?');
        });
    }

    it('before= with the same order a page uses: DESC by default, the cursor bounding the top', async function () {
        const page = await run('getMints', 'block', { page: '2' });
        const keyset = await run('getMints', 'block', { before: '500' });
        const strip = (sql) => sql.replace(/ AND m\.action_index < \?/, '').replace(/ OFFSET \?$/, '');
        const pageSql = page.calls.find((c) => /FROM\s+mints m/.test(c.sql)).sql;
        const keysetSql = keyset.calls.find((c) => /FROM\s+mints m/.test(c.sql)).sql;
        expect(strip(keysetSql)).to.equal(strip(pageSql));
    });

    it('caps limit at the method maximum', async function () {
        const { calls } = await run('getMints', 'block', { before: '500', limit: '99999' });
        const [hit] = boundAt(calls, ' AND m.action_index < ?');
        expect(hit.sql).to.match(/LIMIT 100\s*$/);
    });

    it('binds the cursor, never splices it: a value is never in the SQL text', async function () {
        const { calls } = await run('getIssues', 'block', { before: '987654321' });
        for (const c of calls)
            expect(c.sql).to.not.include('987654321');
    });

    for (const [method, table] of [['getOrders', 'orders'], ['getSwaps', 'swaps']]) {
        it(method + ' by token binds the ticker once, so ?page=2 binds its OFFSET and not the ticker', async function () {
            const { calls } = await run(method, 'token', { page: '2' });
            const list = calls.find((c) => new RegExp('FROM\\s+' + table + ' m').test(c.sql) && /OFFSET/.test(c.sql));
            expect(placeholders(list.sql)).to.equal(list.args.length);
            expect(list.args).to.deep.equal(['TEST', 100]);
        });
    }

    it('?page= alone is unchanged: OFFSET ? and no cursor predicate', async function () {
        const { calls, config } = await run('getMints', 'block', { page: '101' });
        const list = calls.find((c) => /FROM\s+mints m/.test(c.sql));
        expect(list.sql).to.match(/OFFSET \?$/);
        expect(list.sql).to.not.include('m.action_index < ?');
        expect(list.args[list.args.length - 1]).to.equal(10000);
        expect(config.data.sql.keyset).to.equal(undefined);
    });
});
