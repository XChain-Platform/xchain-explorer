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
 * The contract identity manifest, on the reader side: the four meta columns
 * the indexer stores for a conforming deploy and the surfaces that show them.
 *
 * A contract now carries a declared name, description and version, extracted
 * into four columns and a FULLTEXT index by the indexer. Everything here is
 * about what the EXPLORER does with them: which columns each contract query
 * names, what the parsed `meta` object is when meta_json is not a plain object,
 * and the two search paths that read the index rather than scanning with LIKE.
 *
 * The MATCH lanes get the most attention, because they are the only queries in
 * this service whose bound value has query-language meaning: MATCH ... AGAINST
 * (? IN BOOLEAN MODE) reads +, -, ~, *, ", ( ), < > and @ inside the value as
 * operators, so a term is sanitized before it is bound and a term with nothing
 * left is answered as no results rather than as a match on everything.
 *********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function makeDb(){
    const db = new Database({ configInfo, util });
    // RBTC -> BTC, the same base-chain map getContractBalance derives a contract's
    // C:<CHAIN>:<action_index> address from.
    db.baseCoin = { BTC: 'BTC', RBTC: 'BTC' };
    return db;
}

const META = { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '2.0.0' };

function contractRow(overrides = {}){
    return Object.assign({
        action:            'DEPLOY',
        action_index:      900,
        action_format:     0,
        source:            'deployerAddr',
        code:              'module.exports={}',
        code_hash:         'abc123',
        api_version:       1,
        cooldown_blocks:   null,
        slash_destination: null,
        meta_name:         'Escrow',
        meta_description:  'Two-party escrow with an arbiter',
        meta_version:      '2.0.0',
        meta_json:         JSON.stringify(META),
        block_index:       500,
        timestamp:         1700000000,
        tx_hash:           'tx900',
        tx_index:          90,
        status:            'valid',
        permissions:       null,
        max_take_bps:      null
    }, overrides);
}

const contractCfg = () => makeConfig({
    data: { search: '900', sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 } }
});

describe('contract identity manifest: the explorer side', function(){

    afterEach(() => sinon.restore());

    describe('the contract object (getContract)', function(){

        it('names all four meta columns in its explicit column list', async function(){
            const db = makeDb();
            let captured;
            sinon.stub(db, 'doQuery').callsFake(async (c, query) => {
                if(captured === undefined) captured = query;
                return [contractRow()];
            });
            await db.getContract(contractCfg());
            for(const col of ['m.meta_name', 'm.meta_description', 'm.meta_version', 'm.meta_json'])
                expect(captured, 'contract SELECT is missing ' + col).to.include(col);
        });

        it('serves the three flat fields and the parsed meta object', async function(){
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            const [data] = await db.getContract(contractCfg());
            expect(data.meta_name).to.equal('Escrow');
            expect(data.meta_description).to.equal('Two-party escrow with an arbiter');
            expect(data.meta_version).to.equal('2.0.0');
            expect(data.meta).to.deep.equal(META);
        });

        it('serves the parsed object only, never the raw meta_json string beside it', async function(){
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            const [data] = await db.getContract(contractCfg());
            expect(data).to.not.have.property('meta_json');
        });

        it('carries unknown meta keys through, which is what meta_json is for', async function(){
            const db = makeDb();
            const wide = { name: 'Escrow', description: 'd', version: '1', author: 'someone', url: 'https://x' };
            sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: JSON.stringify(wide) })]);
            const [data] = await db.getContract(contractCfg());
            expect(data.meta).to.deep.equal(wide);
        });

        it('answers meta null for a contract that declared none', async function(){
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([contractRow({
                meta_name: null, meta_description: null, meta_version: null, meta_json: null
            })]);
            const [data] = await db.getContract(contractCfg());
            expect(data.meta).to.equal(null);
            expect(data.meta_name).to.equal(null);
        });

        it('answers meta null for malformed JSON rather than throwing or serving a string', async function(){
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: '{not json' })]);
            const [data] = await db.getContract(contractCfg());
            expect(data.meta).to.equal(null);
        });

        // metaJson is bounded and shape-checked in the isolate, but the column is a
        // TEXT the explorer does not own: a row holding a JSON array or scalar must
        // not reach a consumer as `meta`, which every reader treats as an object.
        it('answers meta null for JSON that is not a plain object', async function(){
            const db = makeDb();
            for(const raw of ['[1,2,3]', '"a string"', '42', 'null']){
                sinon.restore();
                sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: raw })]);
                const [data] = await db.getContract(contractCfg());
                expect(data.meta, 'meta_json ' + raw).to.equal(null);
            }
        });
    });

    describe('the contract list (getContracts)', function(){

        it('names all four meta columns in its explicit column list', async function(){
            const db = makeDb();
            const [query] = await db.getContracts(makeConfig({ data: { method: 'getContracts' } }));
            for(const col of ['m.meta_name', 'm.meta_description', 'm.meta_version', 'm.meta_json'])
                expect(query, 'contracts SELECT is missing ' + col).to.include(col);
        });

        it('binds nothing of its own on the block/address/source lanes', async function(){
            const db = makeDb();
            const [, args] = await db.getContracts(makeConfig({ data: { method: 'getContracts', type: 'source', search: 'addr1' } }));
            expect(args).to.equal(null);
        });

        it('binds the SANITIZED term on the name lane, not the raw path segment', async function(){
            const db = makeDb();
            const [, args] = await db.getContracts(makeConfig({
                data: { method: 'getContracts', type: 'name', search: '+escrow* -"vault"' }
            }));
            expect(args).to.deep.equal(['escrow vault']);
        });

        it('answers the empty page when the term sanitizes to nothing usable', async function(){
            const db = makeDb();
            const [data, args, total] = await db.getContracts(makeConfig({
                data: { method: 'getContracts', type: 'name', search: '+++*' }
            }));
            expect(data).to.deep.equal([]);
            expect(args).to.equal(null);
            expect(total).to.equal(0);
        });

        it('filters the name lane through the FULLTEXT index, not with LIKE', async function(){
            const db = makeDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'name' } }));
            expect(sql).to.include('MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)');
            expect(sql).to.not.include('LIKE');
        });

        it('leaves the other contract lanes exactly as they were', async function(){
            const db = makeDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'source' } }));
            expect(sql).to.include('a2.address=?');
            expect(sql).to.not.include('MATCH');
        });

        // The list rows go through getData, which is where meta_json is parsed for a
        // page of rows; the shared helper is driven directly here.
        it('gives every list row the same parsed meta the single-contract route serves', function(){
            const db = makeDb();
            const row = db.attachContractMeta({ action_index: 5, meta_name: 'Escrow', meta_json: JSON.stringify(META) });
            expect(row.meta).to.deep.equal(META);
            expect(row).to.not.have.property('meta_json');
        });
    });

    describe('the BOOLEAN MODE term sanitizer', function(){

        it('strips every character BOOLEAN MODE reads as an operator', function(){
            const db = makeDb();
            expect(db.fulltextTerm('+escrow -vault ~auction *star "quoted" (group) <a> @1'))
                .to.equal('escrow vault auction star quoted group a 1');
        });

        it('holds the term to the same 3-character floor as the LIKE panels', function(){
            const db = makeDb();
            expect(db.fulltextTerm('ab')).to.equal('');
            expect(db.fulltextTerm('  a  ')).to.equal('');
            expect(db.fulltextTerm('esc')).to.equal('esc');
        });

        it('answers empty for an absent term instead of binding the word null', function(){
            const db = makeDb();
            expect(db.fulltextTerm(null)).to.equal('');
            expect(db.fulltextTerm(undefined)).to.equal('');
        });
    });

    // EXECUTE / DEPOSIT / WITHDRAW name a contract by index; the identity comes off
    // the contracts row through a LEFT JOIN, so a call against a pre-activation
    // contract still answers the row (with nulls) rather than disappearing.
    // Driven against the shipped SQL rather than matched as text: a JOIN written on
    // the wrong key type-checks fine and answers the wrong contract.
    describe('the EXECUTE / DEPOSIT / WITHDRAW payloads', function(){

        let sqlite = null;
        try { sqlite = require('node:sqlite'); } catch(e){ sqlite = null; }
        const handlers = require('../../src/action-detail/contracts.js');

        beforeEach(function(){ if(!sqlite) this.skip(); });

        function seed(){
            const sq = new sqlite.DatabaseSync(':memory:');
            sq.exec(`
                CREATE TABLE actions            (action_index INTEGER, action_format INTEGER, action_id INTEGER, tx_index INTEGER, source_id INTEGER, block_index INTEGER);
                CREATE TABLE transactions       (tx_index INTEGER, block_index INTEGER, source_id INTEGER, tx_hash_id INTEGER);
                CREATE TABLE blocks             (block_index INTEGER, block_time INTEGER);
                CREATE TABLE index_actions      (id INTEGER, action TEXT);
                CREATE TABLE index_addresses    (id INTEGER, address TEXT);
                CREATE TABLE index_statuses     (id INTEGER, status TEXT);
                CREATE TABLE index_transactions (id INTEGER, hash TEXT);
                CREATE TABLE index_tickers      (id INTEGER, tick TEXT);
                CREATE TABLE contracts          (action_index INTEGER, meta_name TEXT, meta_version TEXT);
                CREATE TABLE contract_executions(action_index INTEGER, contract_index INTEGER, caller_id INTEGER, method_name TEXT, input_params TEXT, gas_used INTEGER, gas_limit INTEGER, emitted_count INTEGER, error_message TEXT, status_id INTEGER);
                CREATE TABLE deposits           (action_index INTEGER, contract_index INTEGER, source_id INTEGER, tick_id INTEGER, amount TEXT, status_id INTEGER);
                INSERT INTO index_actions      VALUES (9, 'EXECUTE');
                INSERT INTO index_addresses    VALUES (1, 'caller-address');
                INSERT INTO index_statuses     VALUES (1, 'valid');
                INSERT INTO index_transactions VALUES (1, 'tx-hash');
                INSERT INTO index_tickers      VALUES (1, 'XCHAIN');
                INSERT INTO blocks             VALUES (10, 1700000000);
                INSERT INTO actions            VALUES (700, 0, 9, 700, 1, 10), (800, 0, 9, 800, 1, 10);
                INSERT INTO transactions       VALUES (700, 10, 1, 1), (800, 10, 1, 1);
                INSERT INTO contracts          VALUES (42, 'Escrow', '2.0.0'), (43, NULL, NULL);
            `);
            return sq;
        }

        function run(sq, sql, index){
            const row = sq.prepare(String(sql)).get(index);
            return row === undefined ? null : row;
        }

        it('an EXECUTE answers the called contract name and version', function(){
            const sq = seed();
            sq.exec(`INSERT INTO contract_executions VALUES (700, 42, 1, 'release', NULL, 10, 100, 0, NULL, 1)`);
            const row = run(sq, handlers.EXECUTE.queries().query, 700);
            expect(row.contract_index).to.equal(42);
            expect(row.contract_meta_name).to.equal('Escrow');
            expect(row.contract_meta_version).to.equal('2.0.0');
        });

        it('an EXECUTE against a pre-activation contract still answers, with nulls', function(){
            const sq = seed();
            sq.exec(`INSERT INTO contract_executions VALUES (700, 43, 1, 'release', NULL, 10, 100, 0, NULL, 1)`);
            const row = run(sq, handlers.EXECUTE.queries().query, 700);
            expect(row, 'the LEFT JOIN must not drop the execution row').to.be.an('object');
            expect(row.contract_meta_name).to.equal(null);
        });

        it('a DEPOSIT answers the custody contract name and version', function(){
            const sq = seed();
            sq.exec(`INSERT INTO deposits VALUES (800, 42, 1, 1, '100', 1)`);
            const row = run(sq, handlers.DEPOSIT.queries({ type: 'DEPOSIT' }).query, 800);
            expect(row.contract_meta_name).to.equal('Escrow');
            expect(row.contract_meta_version).to.equal('2.0.0');
            expect(row.tick).to.equal('XCHAIN');
        });

        it('WITHDRAW shares the shape, on its own table', function(){
            const sq = seed();
            sq.exec('CREATE TABLE withdrawals (action_index INTEGER, contract_index INTEGER, source_id INTEGER, tick_id INTEGER, amount TEXT, status_id INTEGER)');
            sq.exec(`INSERT INTO withdrawals VALUES (800, 42, 1, 1, '100', 1)`);
            const row = run(sq, handlers.WITHDRAW.queries({ type: 'WITHDRAW' }).query, 800);
            expect(row.contract_meta_name).to.equal('Escrow');
        });
    });

    describe('global search: contract is the fifth category', function(){

        // Counts run first, one query per category, then the matched category's rows.
        function stubSearch(db, counts, rows){
            let call = 0;
            return sinon.stub(db, 'doQuery').callsFake(async () => {
                if(call < counts.length) return [{ count: counts[call++] }];
                call++;
                return rows;
            });
        }

        const searchCfg = (type) => makeConfig({
            coin: 'RBTC',
            data: { method: 'getSearch', search: 'escrow', type, sql: { limit: 10 } }
        });

        it('reports a contracts total on every search, typed or not', async function(){
            const db = makeDb();
            stubSearch(db, [0, 0, 0, 0, 3], []);
            const [data] = await db.getSearch(searchCfg('address'));
            expect(data.totals).to.have.property('contracts', 3);
        });

        // The short-term guard returns before any read; a search UI reads the whole
        // totals map, so the contracts key has to be there to be zero.
        it('reports contracts: 0 on a term too short to search at all', async function(){
            const db = makeDb();
            const spy = sinon.spy(db, 'doQuery');
            const cfg = searchCfg('contract');
            cfg.data.search = 'ab';
            const [data, , total] = await db.getSearch(cfg);
            expect(data.totals.contracts).to.equal(0);
            expect(total).to.equal(0);
            expect(spy.callCount).to.equal(0);
        });

        it('counts contracts through the FULLTEXT index rather than with LIKE', async function(){
            const db = makeDb();
            const queries = [];
            sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
            await db.getSearch(searchCfg('address'));
            const contractCount = queries.find((q) => /FROM contracts/.test(q));
            expect(contractCount, 'no contract count query ran').to.be.a('string');
            expect(contractCount).to.include('MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)');
        });

        it('runs no contract query at all when the term is nothing but operators', async function(){
            const db = makeDb();
            const queries = [];
            sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
            const cfg = searchCfg('address');
            cfg.data.search = '+++***';
            const [data] = await db.getSearch(cfg);
            expect(queries.some((q) => /FROM contracts/.test(q)), 'a contract query ran on an empty term').to.equal(false);
            expect(data.totals.contracts).to.equal(0);
        });

        it('binds the sanitized term, not the LIKE pattern, on the contract rows query', async function(){
            const db = makeDb();
            const calls = [];
            sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
                calls.push({ q, a });
                return /FROM contracts/.test(q) && /SELECT\s+m\.action_index/.test(q)
                    ? [{ action_index: 42, meta_name: 'Escrow', meta_version: '2.0.0', meta_description: 'Two-party escrow' }]
                    : [{ count: 1 }];
            });
            await db.getSearch(searchCfg('contract'));
            const rowsCall = calls.find((c) => /ORDER BY m.action_index DESC/.test(c.q));
            expect(rowsCall, 'no contract rows query ran').to.be.an('object');
            expect(rowsCall.a).to.deep.equal(['escrow']);
            expect(String(rowsCall.a[0])).to.not.include('%');
        });

        it('shapes a hit as name, version, derived address and a description snippet', async function(){
            const db = makeDb();
            sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
                if(/ORDER BY m.action_index DESC/.test(q))
                    return [{ action_index: 42, meta_name: 'Escrow', meta_version: '2.0.0', meta_description: 'Two-party escrow' }];
                return [{ count: 1 }];
            });
            const [data] = await db.getSearch(searchCfg('contract'));
            expect(data.data).to.deep.equal([{
                action_index:     42,
                contract_address: 'C:BTC:42',
                meta_name:        'Escrow',
                meta_version:     '2.0.0',
                snippet:          'Two-party escrow'
            }]);
        });

        it('bounds the snippet so one description cannot take over the results list', async function(){
            const db = makeDb();
            const long = 'x'.repeat(512);
            sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
                if(/ORDER BY m.action_index DESC/.test(q))
                    return [{ action_index: 42, meta_name: 'Escrow', meta_version: null, meta_description: long }];
                return [{ count: 1 }];
            });
            const [data] = await db.getSearch(searchCfg('contract'));
            expect(data.data[0].snippet).to.have.lengthOf(160);
            expect(data.data[0].snippet.endsWith('…')).to.equal(true);
            expect(data.data[0].meta_version).to.equal(null);
        });

        it('leaves the four LIKE panels untouched', async function(){
            const db = makeDb();
            const queries = [];
            sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
            await db.getSearch(searchCfg('address'));
            const likePanels = queries.filter((q) => /LIKE LOWER/.test(q));
            expect(likePanels).to.have.lengthOf(4);
        });
    });
});
