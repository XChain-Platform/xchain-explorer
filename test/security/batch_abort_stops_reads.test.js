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
 * Security: a batch read stops when its client goes away
 *
 * One POST /{COIN}/api/balances body of twenty addresses is forty per-address
 * reads. A caller that sends the body and hangs up at once used to get all
 * forty run to completion for nobody, and the global concurrency gate freed
 * its slot at the hang-up, so a burst of such requests reached the database
 * far past the cap. These tests drive the real batch methods with a counting
 * readApi stub and a response that closes mid-batch, and require that no new
 * read starts after the close, nothing is sent, and the gate hold the batch
 * takes is dropped exactly once.
 *
 * Run: mocha test/security/batch_abort_stops_reads.test.js --timeout 5000
 */

'use strict';

const { expect }       = require('chai');
const { EventEmitter } = require('events');
const { methods }      = require('../../src/explorer/batch.js');

// Mirrors BATCH_READ_CONCURRENCY in src/explorer/batch.js: the reads that may
// already be running when the close lands and are allowed to finish.
const BATCH_READ_CONCURRENCY = 8;
const ADDRESSES = Array.from({ length: 20 }, (_, i) => 'addr' + String(i + 1).padStart(2, '0'));
// processBalancesBatchRequest reads two parts per address.
const READS_PER_ADDRESS = 2;

function fakeRes(options){
    const res = new EventEmitter();
    res.destroyed = false;
    res.set    = () => res;
    res.status = () => res;
    res.send   = () => res;
    res.hold   = { taken: 0, dropped: 0 };
    if(options && options.gate){
        const controller = new AbortController();
        res.abortSignal  = controller.signal;
        res.abortViaSignal = () => controller.abort();
        res.holdSlot = () => {
            res.hold.taken++;
            return () => { res.hold.dropped++; };
        };
    }
    return res;
}

/**
 * A batch context: the real batch methods over a stub readApi that counts
 * every read it is asked to start and yields before answering, so reads
 * overlap the way pooled DB reads do. onRead(n) runs as read n starts.
 */
function buildBatch(onRead){
    const ctx   = Object.create(methods);
    const stats = { reads: 0, sends: [] };
    ctx.util = {
        isAddressLike: (value) => /^[A-Za-z0-9]{1,128}$/.test(value),
        jsonStringify: (value) => JSON.stringify(value)
    };
    ctx.configInfo = { getConfig: async () => ({}) };
    ctx.readApi = async () => {
        stats.reads++;
        const n = stats.reads;
        await new Promise((resolve) => setImmediate(resolve));
        if(onRead) onRead(n);
        return { code: 200, json: { ok: true }, headers: {} };
    };
    const realSend = ctx.sendBatchJson;
    ctx.sendBatchJson = function(res, code, json){
        stats.sends.push({ code, json, destroyed: res.destroyed === true });
        return realSend.call(this, res, code, json);
    };
    return { ctx, stats };
}

// Most reads a batch may have started when the client goes away as read n
// answers: the n - 1 that already answered plus one in flight per worker.
function maxReadsAfterCloseAt(n){
    return (n - 1) + BATCH_READ_CONCURRENCY;
}

function closeClient(res){
    res.destroyed = true;
    res.emit('close');
}

function balancesRequest(){
    return { params: { coin: 'rbtc' }, body: { addresses: ADDRESSES.slice() }, query: {} };
}

describe('Security: a batch read stops when its client goes away', function () {

    it('runs every read and answers when the client stays (control)', async function () {
        const { ctx, stats } = buildBatch();
        const res = fakeRes({ gate: true });

        await ctx.processBalancesBatchRequest(balancesRequest(), res);

        // The control is what makes the abort cases meaningful: an address
        // refusal or an early return here would make "few reads" pass vacuously.
        expect(stats.reads).to.equal(ADDRESSES.length * READS_PER_ADDRESS);
        expect(stats.sends).to.have.length(1);
        expect(stats.sends[0].code).to.equal(200);
        expect(Object.keys(stats.sends[0].json)).to.have.length(ADDRESSES.length);
        expect(res.hold).to.deep.equal({ taken: 1, dropped: 1 });
    });

    it('starts no read after the client closes during the first read', async function () {
        let res;
        const { ctx, stats } = buildBatch((n) => { if(n === 1) closeClient(res); });
        res = fakeRes({ gate: true });

        await ctx.processBalancesBatchRequest(balancesRequest(), res);

        expect(stats.reads).to.equal(1);
        expect(stats.sends).to.have.length(0);
        expect(res.hold).to.deep.equal({ taken: 1, dropped: 1 });
    });

    it('stops the fan-out mid-batch: only reads already running finish', async function () {
        const ABORT_AT = 4;
        let res;
        let readsAtClose = null;
        const { ctx, stats } = buildBatch((n) => {
            if(n === ABORT_AT){
                readsAtClose = stats.reads;
                closeClient(res);
            }
        });
        res = fakeRes({ gate: true });

        await ctx.processBalancesBatchRequest(balancesRequest(), res);

        expect(readsAtClose).to.be.a('number');
        // Nothing new starts after the close. Reads answer in start order, so
        // when read N answers, N - 1 have finished and at most one per worker
        // is still running; that is everything the server may still do.
        expect(stats.reads).to.equal(readsAtClose);
        expect(stats.reads).to.be.at.most(maxReadsAfterCloseAt(ABORT_AT));
        expect(stats.reads).to.be.below(ADDRESSES.length * READS_PER_ADDRESS);
        expect(stats.sends, 'nothing is sent on a destroyed response').to.have.length(0);
        expect(res.hold).to.deep.equal({ taken: 1, dropped: 1 });
    });
});

describe('Security: a batch read stops on every abort source', function () {

    it('honours the gate abort signal alone, without a close event', async function () {
        let res;
        const { ctx, stats } = buildBatch((n) => { if(n === 2) res.abortViaSignal(); });
        res = fakeRes({ gate: true });

        await ctx.processBalancesBatchRequest(balancesRequest(), res);

        expect(stats.reads).to.be.at.most(maxReadsAfterCloseAt(2));
        expect(stats.sends).to.have.length(0);
        expect(res.hold).to.deep.equal({ taken: 1, dropped: 1 });
    });

    it('stops on close when no gate is mounted (gate disabled or route skipped)', async function () {
        let res;
        const { ctx, stats } = buildBatch((n) => { if(n === 3) closeClient(res); });
        res = fakeRes();

        await ctx.processBalancesBatchRequest(balancesRequest(), res);

        expect(stats.reads).to.be.at.most(maxReadsAfterCloseAt(3));
        expect(stats.sends).to.have.length(0);
    });

    it('drops the gate hold even when a read throws', async function () {
        const { ctx } = buildBatch();
        ctx.configInfo = { getConfig: async () => { throw new Error('config unavailable'); } };
        const res = fakeRes({ gate: true });

        let thrown = null;
        try { await ctx.processBalancesBatchRequest(balancesRequest(), res); } catch(err){ thrown = err; }

        expect(thrown).to.be.an('error');
        expect(res.hold).to.deep.equal({ taken: 1, dropped: 1 });
    });
});
