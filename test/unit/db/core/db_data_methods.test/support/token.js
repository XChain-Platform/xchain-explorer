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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, mockResults, makeDb, cfg } = require('./helpers.js');

describe('Database#getToken', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when no token found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const config = cfg({ data: { search: 'MISSING' } });
        const [data] = await db.getToken(config);
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data).to.be.null;
    });

    it('filters by name (t2.tick) for a plain ticker search', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('t2.tick=?');
        expect(args).to.deep.equal(['XCHAIN']);
    });

    it('filters by tick_id for a ^id search, and does not truncate it', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: '^1234' } }));
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('t1.tick_id=?');
        expect(queryStr).to.not.include('t2.tick=?');
        expect(args).to.deep.equal([1234]); // NOT 123
    });

    it('returns an object with info, callback, market, lists, locks, mints, supply, projects, registry keys', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // projects/registry resolve to []/null with no baseCoin map (un-inited db).
        // controllers surfaces active controller bindings ([] with no pool/tick id).
        // open_polls lists the token's currently-open governance polls.
        // linked_files lists the FILEs LINKed to the token (the NFT pattern), so the
        // info column can show on-chain artwork instead of "no additional information".
        expect(data).to.have.keys(['info', 'callback', 'market', 'lists', 'locks', 'mints', 'supply', 'projects', 'registry', 'controllers', 'open_polls', 'linked_files']);
        expect(data.projects).to.deep.equal([]);
        expect(data.registry).to.equal(null);
        expect(data.controllers).to.deep.equal([]);
    });
});

describe('Database#getToken', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getTokenOpenPolls selects only open polls for the tick, soonest close first', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const rows = await db.getTokenOpenPolls(cfg({ data: {} }), 'XCHAIN');
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include("m.poll_status='open'");
        expect(queryStr).to.include('pt.tick=?');
        expect(queryStr).to.include('ORDER BY m.end_block ASC');
        expect(queryStr).to.include('m.callback_contract_index');
        expect(args).to.deep.equal(['XCHAIN']);
        expect(rows).to.deep.equal([]);
    });

    it('maps lock_max_supply="1" to locks.max_supply === true', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.locks.max_supply).to.be.true;
    });

    it('maps lock_mint="0" to locks.mint === false', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.locks.mint).to.be.false;
    });

    it('formats supply.current with bcformat using decimals', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ coin: 'BTC', data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // tokenRow supply='1000000', decimals=8 → '1000000.00000000'
        expect(data.supply.current).to.equal('1000000.00000000');
    });

    it('formats supply.max with bcformat using decimals', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ coin: 'BTC', data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.supply.max).to.equal('21000000.00000000');
    });

    it('groups allow_list into lists.allow', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.lists).to.have.property('allow');
    });
});

describe('Database#getToken', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('groups block_list into lists.block', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.lists).to.have.property('block');
    });

    it('groups coin_price into market.price', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.market.price).to.equal(100);
    });

    it('groups coin_floor into market.floor', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.market.floor).to.equal(50);
    });

    it('groups max_mint into mints.max', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.mints.max).to.equal(100);
    });

    it('groups mint_address_max into mints.address_max', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.mints.address_max).to.equal(0);
    });

    it('groups callback_block into callback.block', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.callback.block).to.equal(0);
    });
});

describe('Database#getToken', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('exposes the token decimals (but never callback_decimals) in info + supply', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        // decimals power client-side NFT-pattern classification (DECIMALS=0 +
        // LOCK_MAX_SUPPLY=1); callback_decimals stays internal
        expect(data.info.decimals).to.equal(8);
        expect(data.supply.decimals).to.equal(8);
        expect(data.info).to.not.have.property('callback_decimals');
    });

    it('places tick and owner in data.info', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.tick).to.equal('XCHAIN');
        expect(data.info.owner).to.equal('ownerAddr1');
    });

    it('places description in data.info', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());

        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.description).to.equal('XChain Gas Token');
    });
});

let db;

// A column only comes back from a DB when the SELECT asked for it. Rather than
// hand a stub a fixed row the query never requested, derive the returned row
// from the query's own column list, so dropping a column from the SELECT drops
// it from the response exactly as MariaDB would. SQL comments are stripped
// first: the SELECT's comment names these columns in prose, and matching that
// prose would keep a dropped column "present".
function stubFromSelect(overrides){
    const base = Object.assign(mockResults.tokenRow()[0], overrides || {});
    return sinon.stub(db, 'doQuery').callsFake(async (cfgArg, queryStr) => {
        const sql = String(queryStr).replace(/--[^\n]*/g, '');
        // getToken runs follow-up lookups (projects, controllers, open polls,
        // linked files) through the same doQuery; only the token SELECT itself
        // answers with a row.
        if(!sql.includes('tokens t1')) return [];
        const row = {};
        for(const key of Object.keys(base)){
            if(new RegExp('(^|[\\s,.])' + key + '(\\s|,|$)').test(sql))
                row[key] = base[key];
        }
        return [row];
    });
}

// Token-bridge columns (ISSUE format 7). The wallet's tokenInfo projection
// (xchain-wallet/packages/core/src/flows/tokenInfo.js) reads them off THIS
// response as info.bridge_chains, info.min_depth, locks.bridge and info.bridged,
// so both halves matter: the SELECT has to ask the DB for the columns, and the
// grouping loop has to land each one where the wallet looks.
describe('Database#getToken bridge columns', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('lands bridge_chains, min_depth and bridged in info, and lock_bridge in locks.bridge', async () => {
        stubFromSelect();
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        // The four reads the wallet projection performs, at their exact paths
        expect(data.info.bridge_chains).to.equal('LTC,DOGE');
        expect(data.info.min_depth).to.equal(6);
        expect(data.locks.bridge).to.equal(true);
        expect(data.info.bridged).to.equal(1);
    });

    it('keeps lock_bridge out of info (the wallet reads it as locks.bridge)', async () => {
        stubFromSelect();
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info).to.not.have.property('lock_bridge');
        expect(data.locks).to.not.have.property('lock_bridge');
    });

    it('passes an unset bridge_chains/min_depth through as null instead of defaulting them', async () => {
        // A token that never opted in: BRIDGE_CHAINS/MIN_DEPTH are NULL in the row.
        // null must survive to the wallet, which reads it as "not bridgeable" rather
        // than inventing a destination list or a depth.
        stubFromSelect({ bridge_chains: null, min_depth: null, lock_bridge: '0', bridged: 0 });
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.bridge_chains).to.equal(null);
        expect(data.info.min_depth).to.equal(null);
        expect(data.locks.bridge).to.equal(false);
        expect(data.info.bridged).to.equal(0);
    });

    it("carries the '-' opt-out sentinel through unchanged", async () => {
        // BRIDGE_CHAINS='-' is the issuer saying "opted out", a different claim from
        // NULL ("never set"); the wallet distinguishes them, so the explorer must not
        // normalise one into the other.
        stubFromSelect({ bridge_chains: '-' });
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.bridge_chains).to.equal('-');
    });

    it('passes a BIGINT min_depth through untouched so the REST serializer renders it', async () => {
        // min_depth is BIGINT UNSIGNED and the pool leaves bigIntAsNumber off, so the
        // driver hands back a BigInt. utility.jsonStringify renders a BigInt as its
        // decimal string, which is the wire value the wallet parses; narrowing it to
        // a Number here would silently truncate a large depth instead.
        stubFromSelect({ min_depth: 6n });
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.min_depth).to.equal(6n);
        expect(JSON.parse(db.util.jsonStringify(data)).info.min_depth).to.equal('6');
    });
});

describe('Database#getToken bridge columns', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('asks the DB for all four bridge columns off the tokens table', async () => {
        const dq = stubFromSelect();
        await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        const sql = String(dq.firstCall.args[1]).replace(/--[^\n]*/g, '');
        for(const col of ['bridge_chains', 'min_depth', 'lock_bridge', 'bridged'])
            expect(sql, col).to.include('t1.' + col);
    });
});
