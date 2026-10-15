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
 * No cache serves an orphaned block after a same-height reorg.
 *
 * A block replaced by another at the same height leaves the tip height where it
 * was. The balances/holders/tokens result cache is keyed on the tip's identity
 * (ledger and actions hash) as well as its height, the request-path tip reading
 * bumps the reorg generation that retires the address-id and action-detail
 * LRUs, every request reads the tip first (processRequest -> observeCoinTip),
 * and an explorer with the live feed off still runs the reorg poll.
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const XChainExplorer           = require('../../../../src/XChainExplorer.js');
const { startWebsockets }      = require('../../../../src/http/api_boot/websocket.js');
const { createExplorerDrain }  = require('../../../../src/http/shutdown.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

// A chain whose tip block can be swapped for another at the same height. Answers
// the request-path tip read, the identity read at an earlier height, the poll's
// tip and row reads, and counts every other statement as a page/id read.
function makeChain(){
    const chain = { height: 100, ledger: 'L100', actions: 'A100', reads: 0, addressId: 4 };
    chain.replaceTip = (ledger, actions) => { chain.ledger = ledger; chain.actions = actions; };
    chain.route = async (config, sql) => {
        sql = String(sql);
        if(/MAX\(block_index\)/.test(sql))
            return [{ tip: chain.height, block_hash: chain.ledger, actions_hash: chain.actions }];
        if(/ORDER BY b1\.block_index DESC/.test(sql))
            return [{ block_index: chain.height, block_hash: chain.ledger }];
        if(/WHERE b1\.block_index=\?/.test(sql))
            return [{ block_hash: chain.ledger, actions_hash: chain.actions }];
        chain.reads++;
        if(/FROM\s+index_addresses/.test(sql)) return [{ id: chain.addressId }];
        if(/count\(\*\)/i.test(sql)) return [{ total: 1 }];
        return [{ tick: 'XCHAIN', amount: String(chain.reads) }];
    };
    return chain;
}

function makeDb(chain){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.getCanonicalTick = async (config, value) => value;
    sinon.stub(db, 'doQuery').callsFake(chain.route);
    return db;
}

function balancesCfg(){
    return makeConfig({ coin: 'BTC', data: { method: 'getBalances', search: 'addr1' } });
}

// Registers a fresh chain and db per test, with the tip memo off so every call
// reads the tip; returns a holder the tests read them from.
function freshChainPerTest(){
    const t = {};
    beforeEach(() => {
        process.env.EXPLORER_TIP_MEMO_MS = '0';
        t.chain = makeChain();
        t.db = makeDb(t.chain);
    });
    afterEach(() => { sinon.restore(); delete process.env.EXPLORER_TIP_MEMO_MS; });
    return t;
}

describe('the result cache across a same-height reorg', function () {
    const t = freshChainPerTest();

    it('the result cache misses when the tip block is replaced at the same height', async () => {
        const { chain, db } = t;
        sinon.stub(db, 'getQuery').resolves(['SELECT page', [], 'SELECT count(*) as total']);
        await db.getData(balancesCfg());
        const first = chain.reads;
        await db.getData(balancesCfg());
        expect(chain.reads, 'same block: served from the cache').to.equal(first);

        chain.replaceTip('L100b', 'A100b');
        await db.getData(balancesCfg());
        expect(chain.reads, 'replaced block: read again').to.be.above(first);
    });

    it('the generation token carries the height and the block identity', async () => {
        const { chain, db } = t;
        expect(await db.resultCacheGeneration({ coin: 'BTC' })).to.equal('100:L100/A100');
        chain.replaceTip('L100b', 'A100');
        expect(await db.resultCacheGeneration({ coin: 'BTC' })).to.equal('100:L100b/A100');
    });

});

describe('the id/action caches across a same-height reorg', function () {
    const t = freshChainPerTest();

    it('the request-path tip reading retires the address-id cache', async () => {
        const { chain, db } = t;
        const cfg = { coin: 'BTC' };
        await db.resultCacheGeneration(cfg);
        expect(await db.getAddressId(cfg, 'P1')).to.equal(4);
        chain.addressId = 9;
        expect(await db.getAddressId(cfg, 'P1'), 'cached').to.equal(4);

        chain.replaceTip('L100b', 'A100b');
        await db.resultCacheGeneration(cfg);
        expect(await db.getAddressId(cfg, 'P1'), 'after the replaced block').to.equal(9);
    });

    it('a clean append keeps the id/action caches', async () => {
        const { chain, db } = t;
        const cfg = { coin: 'BTC' };
        await db.resultCacheGeneration(cfg);
        await db.getAddressId(cfg, 'P1');
        chain.addressId = 9;
        chain.height = 101; chain.replaceTip('L101', 'A101');
        // The row at height 100 still reads L101 in this stub, so model the real
        // chain: height 100 keeps its block.
        chain.route = ((route) => async (config, sql, args) => (/WHERE b1\.block_index=\?/.test(String(sql)) && args[0] === 100)
            ? [{ block_hash: 'L100', actions_hash: 'A100' }] : route(config, sql, args))(chain.route);
        db.doQuery.callsFake(chain.route);
        await db.resultCacheGeneration(cfg);
        expect(await db.getAddressId(cfg, 'P1')).to.equal(4);
        expect(db._reorgGen.BTC || 0).to.equal(0);
    });

    it('the poll still reports the reorg after the request path saw it first', async () => {
        const { chain, db } = t;
        await db.checkReorgAndInvalidate({ coin: 'BTC' });
        await db.resultCacheGeneration({ coin: 'BTC' });
        chain.replaceTip('L100b', 'A100b');
        await db.resultCacheGeneration({ coin: 'BTC' });
        expect(await db.checkReorgAndInvalidate({ coin: 'BTC' })).to.equal(true);
    });
});

describe('every request reads the coin tip first', function () {
    it('observeCoinTip reads the tip of the pooled coin the path names', async () => {
        const seen = [];
        const fake = { db: { pools: { RBTC: {} }, resultCacheGeneration: async (c) => { seen.push(c.coin); return '1'; } } };
        await XChainExplorer.prototype.observeCoinTip.call(fake, { path: '/rbtc/api/action/5' });
        await XChainExplorer.prototype.observeCoinTip.call(fake, { path: '/DOGE/api/action/5' });
        await XChainExplorer.prototype.observeCoinTip.call(fake, { path: '/' });
        expect(seen).to.deep.equal(['RBTC']);
    });

    it('processRequest reads the tip before it serves', async () => {
        const order = [];
        const fake = {
            observeCoinTip: async () => { order.push('tip'); },
            answerActionNotYetIndexed: async () => { order.push('serve'); return true; }
        };
        await XChainExplorer.prototype.processRequest.call(fake, { path: '/RBTC/api/action/5' }, {});
        expect(order).to.deep.equal(['tip', 'serve']);
    });
});

describe('the reorg poll runs with the live feed off', function () {
    let clock;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => { clock.restore(); sinon.restore(); });

    it('WS_ENABLED=false polls every pooled coin and the drain stops it', async () => {
        const polled = [];
        const runtime = {};
        const db = { pools: { BTC: {}, RBTC: {} }, checkReorgAndInvalidate: async (c) => { polled.push(c.coin); return false; } };
        startWebsockets({ configInfo: { env: { WS_ENABLED: 'false', WS_POLL_INTERVAL: '5000' } },
            explorer: { db }, httpServer: {}, httpsServer: null, runtime });
        expect(runtime.reorgPoll, 'a poll handle on the runtime').to.be.an('object');
        expect(runtime.changeDetector).to.equal(undefined);

        await clock.tickAsync(5000);
        expect(polled).to.deep.equal(['BTC', 'RBTC']);

        await createExplorerDrain(Object.assign(runtime, { log: { warn(){} } }))();
        await clock.tickAsync(15000);
        expect(polled).to.have.length(2);
    });
});
