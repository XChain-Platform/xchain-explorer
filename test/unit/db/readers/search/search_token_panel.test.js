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
 * The token search panel's SQL. The tick matches through the index_tickers prefix
 * index on every replica; the description prefix joins only where a B-tree index
 * leads with tokens.description, because `tick LIKE ? OR description LIKE ?` reads
 * every token row and an unindexed description LIKE cannot be bounded on a miss.
 *********************************************************************/

'use strict';

const { sinon, expect, makeConfig, makeDb } = require('../db_contract_meta.test/support/helpers.js');
const { withIndexProbe, panelCalls }       = require('./support/index_probe.js');

const TICK_HITS = 'SELECT t1.id FROM index_tickers t2 INNER JOIN tokens t1 ON (t1.tick_id=t2.id) WHERE t2.tick LIKE ?';
const DESC_HITS = 'SELECT t1.id FROM tokens t1 LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) WHERE t1.description LIKE ?';

const pageHits = hits => hits.replace('SELECT t1.id FROM', 'SELECT t1.id, LEFT(t2.tick, 200) AS tick_key FROM');

const tokenCfg = (limit) => makeConfig({
    coin: 'RTEST',
    data: { method: 'getSearch', search: 'XCH', type: 'token', sql: { limit } }
});

const squash = sql => String(sql).replace(/\s+/g, ' ').trim();
const placeholders = sql => (String(sql).match(/\?/g) || []).length;

// Every count answers 1 so the token page runs; the page answers `rows`.
function stubTokens(db, indexes, rows){
    return sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) =>
        /COUNT\(\*\)/.test(query) ? [{ count: 1 }] : rows, indexes));
}

const tokenCount = stub => panelCalls(stub).find(call => /COUNT\(\*\)/.test(call.args[1]) && /tokens t1/.test(call.args[1]));
const tokenPage  = stub => panelCalls(stub).find(call => !/COUNT\(\*\)/.test(call.args[1]));

async function search(indexes, limit, rows){
    const db   = makeDb();
    const stub = stubTokens(db, indexes, rows || [{ tick: 'XCHAIN', description: 'Gas Token' }]);
    const [data, , total] = await db.getSearch(tokenCfg(limit));
    return { stub, data, total };
}

describe('Database#getSearch token panel without a description index', function(){
    afterEach(() => sinon.restore());

    it('counts tick prefix matches through index_tickers, with no OR and no description scan', async function(){
        const { stub } = await search({ tokenDescription: false }, 10);
        const count = tokenCount(stub);
        expect(squash(count.args[1])).to.equal(`SELECT COUNT(*) AS count FROM (${TICK_HITS} LIMIT 100) bounded_matches`);
        expect(count.args[2]).to.deep.equal(['XCH%']);
    });

    it('pages tick prefix matches in tick order, bounded by the page limit', async function(){
        const { stub, data, total } = await search({ tokenDescription: false }, 10);
        const page = tokenPage(stub);
        expect(squash(page.args[1])).to.equal(
            'SELECT t2.tick, t1.description FROM index_tickers t2 INNER JOIN tokens t1 ON (t1.tick_id=t2.id) ' +
            'WHERE t2.tick LIKE ? ORDER BY t2.tick ASC LIMIT 10');
        expect(page.args[2]).to.deep.equal(['XCH%']);
        expect(data.data).to.deep.equal([{ tick: 'XCHAIN', description: 'Gas Token' }]);
        expect(data.totals.tokens).to.equal(1);
        expect(total).to.equal(1);
    });

    it('never names the description column in any statement', async function(){
        const { stub } = await search({ tokenDescription: false }, 10);
        for(const call of panelCalls(stub)) expect(call.args[1]).to.not.match(/description LIKE/);
    });
});

describe('Database#getSearch token panel with a description index', function(){
    afterEach(() => sinon.restore());

    it('counts the UNION of bounded tick and description hits, each member capped', async function(){
        const { stub } = await search({ tokenDescription: true }, 10);
        const count = tokenCount(stub);
        expect(squash(count.args[1])).to.equal(
            `SELECT COUNT(*) AS count FROM ((${TICK_HITS} LIMIT 100) UNION (${DESC_HITS} LIMIT 100) LIMIT 100) bounded_matches`);
        expect(count.args[2]).to.deep.equal(['XCH%', 'XCH%']);
    });

    // The members carry LEFT(tick, 200) as a VARCHAR sort key so neither the derived
    // table nor the outer sort holds TEXT; tick(200) is UNIQUE under a binary
    // collation, so that key orders exactly as tick does.
    it('pages the top hits of each branch in tick order, then orders the union again', async function(){
        const { stub, data } = await search({ tokenDescription: true }, 10);
        const page = tokenPage(stub);
        expect(squash(page.args[1])).to.equal(
            'SELECT t2.tick, t1.description FROM ' +
            `((${pageHits(TICK_HITS)} ORDER BY tick_key ASC LIMIT 10) UNION (${pageHits(DESC_HITS)} ORDER BY tick_key ASC LIMIT 10)) hits ` +
            'INNER JOIN tokens t1 ON (t1.id=hits.id) LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) ORDER BY hits.tick_key ASC LIMIT 10');
        expect(page.args[2]).to.deep.equal(['XCH%', 'XCH%']);
        expect(data.data).to.deep.equal([{ tick: 'XCHAIN', description: 'Gas Token' }]);
    });

    it('clamps every member LIMIT to 100 when the pager asks for more', async function(){
        const { stub } = await search({ tokenDescription: true }, 999);
        const page = squash(tokenPage(stub).args[1]);
        expect(page.match(/LIMIT (\d+)/g)).to.deep.equal(['LIMIT 100', 'LIMIT 100', 'LIMIT 100']);
    });
});

describe('Database#getSearch token panel binds one value per placeholder', function(){
    afterEach(() => sinon.restore());

    for(const tokenDescription of [false, true]){
        it('with tokenDescription=' + tokenDescription, async function(){
            const { stub } = await search({ tokenDescription }, 10);
            for(const call of panelCalls(stub))
                expect(call.args[2], squash(call.args[1])).to.have.lengthOf(placeholders(call.args[1]));
        });
    }
});

describe('Database#getSearch token description probe', function(){
    afterEach(() => sinon.restore());

    // Only a B-tree index LEADING with description serves `description LIKE 'x%'`;
    // a FULLTEXT index, or description as a later column, leaves the branch off.
    const cases = [
        { label: 'a B-tree prefix index leading with description', rows: [
            { INDEX_NAME: 'description', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'description', SEQ_IN_INDEX: 1 }], on: true },
        { label: 'a FULLTEXT index on description', rows: [
            { INDEX_NAME: 'ft_description', INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'description', SEQ_IN_INDEX: 1 }], on: false },
        { label: 'description as the second column of a B-tree index', rows: [
            { INDEX_NAME: 'owner_desc', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'owner_id',    SEQ_IN_INDEX: 1 },
            { INDEX_NAME: 'owner_desc', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'description', SEQ_IN_INDEX: 2 }], on: false }
    ];
    for(const c of cases){
        it((c.on ? 'joins' : 'skips') + ' the description branch for ' + c.label, async function(){
            const db   = makeDb();
            const stub = sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
                if(/information_schema\.STATISTICS/.test(query)) return args[0] === 'tokens' ? c.rows : [];
                return [{ count: 1 }];
            });
            await db.getSearch(tokenCfg(10));
            const count = stub.getCalls().find(call => /COUNT\(\*\)/.test(call.args[1]) && /tokens t1/.test(call.args[1]));
            expect(/description LIKE/.test(count.args[1])).to.equal(c.on);
        });
    }
});

describe('Database#getSearch token hit lists never carry the TEXT tick', function(){
    afterEach(() => sinon.restore());

    // A TEXT column in a derived table or UNION result is materialized on disk, which
    // costs more than the whole index-served read.
    for(const tokenDescription of [false, true]){
        it('with tokenDescription=' + tokenDescription, async function(){
            const { stub } = await search({ tokenDescription }, 10);
            const lists = panelCalls(stub).filter(c => /tokens t1/.test(c.args[1]))
                .flatMap(call => [...squash(call.args[1]).matchAll(/\(SELECT (.*?) FROM /g)].map(m => m[1]));
            expect(lists).to.not.be.empty;
            for(const list of lists) expect(['t1.id', 't1.id, LEFT(t2.tick, 200) AS tick_key']).to.include(list);
        });
    }
});
