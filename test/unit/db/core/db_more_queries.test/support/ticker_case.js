/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { expect, sinon, makeDb, cfg, makeActionConfig } = require('./helpers.js');

describe('Database ticker case resolution', function () {
    afterEach(function () { sinon.restore(); });

    it('resolves lowercase xchain to the stored canonical ticker and caches the fold', async function () {
        const db = makeDb();
        const queries = [];
        sinon.stub(db, 'doQuery').callsFake(async function (config, query, args) {
            queries.push({ query, args });
            if(query.includes('LOWER(tick)')) return [{ id: 7, tick: 'XCHAIN' }];
            return [];
        });

        expect(await db.getCanonicalTick(cfg(), 'xchain')).to.equal('XCHAIN');
        expect(await db.getCanonicalTick(cfg(), 'XcHaIn')).to.equal('XCHAIN');
        expect(queries).to.have.length(2);
        expect(queries[0].query).to.include('tick=?');
        expect(queries[1].query).to.include('FORCE INDEX (tick)');
        expect(queries[1].args).to.deep.equal(['xchain']);
    });

    it('binds the canonical ticker in route-facing SQL', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async function (config, query) {
            if(query.includes('LOWER(tick)')) return [{ id: 7, tick: 'XCHAIN' }];
            return [];
        });
        const config = makeActionConfig('getVoteDelegations', 'tick', { search: 'xchain' });
        const [query] = await db.getQuery(config);
        expect(config.data.search).to.equal('XCHAIN');
        expect(query).to.include('t3.tick=?');
    });
});
