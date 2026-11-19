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
 *
 * owner_withdraw judged on the DEPLOY block's protocol time. On testnet the
 * indexer reads the gate at the median-time-past of the deploy block, never later
 * than its raw stamp, so a contract stamped at or after the activation but
 * median-stamped before it is still withdrawable. The explorer mirrors that
 * clock with one decoder read per response and serves unknown (null) when it
 * cannot resolve it.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { attachOwnerWithdrawRows } = require('../../../src/contract/owner_withdraw.js');
const { applyPostPasses } = require('../../../src/db/query_sql/data_post.js');

const INSTANT    = 1790492400;
const OPTED_IN   = JSON.stringify({ name: 'Vault', version: '1.0.0', ownerWithdraw: true });
const UNDECLARED = JSON.stringify({ name: 'Pool', version: '1.0.0' });

// The decoder window the explorer reads: each requested height's own row plus the
// stamps before it, every row tagged with the height it was fetched for.
function windowRows(height, raw, previous){
    const rows = [{ requested_block_index: height, block_index: height, block_time: raw }];
    previous.forEach((time, i) => rows.push({ requested_block_index: height, block_index: height - 1 - i, block_time: time }));
    return rows;
}

// A decoder whose every block is stamped `raw` with the eleven blocks before it
// stamped by `previous`; counts the statements it is asked to run.
function fakeDb(previous, opts = {}){
    const db = {
        windowReads: 0,
        getDecoderBlockTimeWindows: async (config, heights) => {
            db.windowReads++;
            if(opts.fail) throw new Error('decoder down');
            if(opts.empty) return [];
            return heights.flatMap((h) => windowRows(h, opts.raw, previous));
        },
        resolveCoinNetwork: async () => ({ coin: 'DOGE', network: 'testnet' }),
        attachContractMeta(row){ delete row.meta_json; return row; }
    };
    return db;
}

const rowAt = (height, raw, meta = UNDECLARED) => ({ block_index: height, timestamp: raw, meta_json: meta });
const LOW  = new Array(11).fill(INSTANT - 500);
const HIGH = new Array(11).fill(INSTANT + 500);

describe('owner_withdraw: deploy-block protocol time on testnet', function(){

    it('serves enabled when the raw stamp is past the instant but the median is still before it', async function(){
        const rows = [rowAt(500, INSTANT + 10)];
        await attachOwnerWithdrawRows(fakeDb(LOW, { raw: INSTANT + 10 }), { coin: 'DOGE' }, rows, 'testnet');
        expect(rows[0].owner_withdraw).to.equal(true);
    });

    it('serves disabled when the median is also at or past the instant', async function(){
        const rows = [rowAt(500, INSTANT + 10)];
        await attachOwnerWithdrawRows(fakeDb(HIGH, { raw: INSTANT + 10 }), { coin: 'DOGE' }, rows, 'testnet');
        expect(rows[0].owner_withdraw).to.equal(false);
    });

    it('serves unknown when the decoder window cannot be read or holds no row for the block', async function(){
        const failing = [rowAt(500, INSTANT + 10)];
        await attachOwnerWithdrawRows(fakeDb(LOW, { fail: true }), { coin: 'DOGE' }, failing, 'testnet');
        expect(failing[0].owner_withdraw).to.equal(null);
        const empty = [rowAt(500, INSTANT + 10)];
        await attachOwnerWithdrawRows(fakeDb(LOW, { empty: true }), { coin: 'DOGE' }, empty, 'testnet');
        expect(empty[0].owner_withdraw).to.equal(null);
    });

    it('reads the decoder once per response however many contracts it carries', async function(){
        for(const count of [3, 30]){
            const db = fakeDb(LOW, { raw: INSTANT + 10 });
            const rows = Array.from({ length: count }, (_, i) => rowAt(500 + i, INSTANT + 10));
            await attachOwnerWithdrawRows(db, { coin: 'DOGE' }, rows, 'testnet');
            expect(db.windowReads, count + ' rows').to.equal(1);
            expect(rows.every((r) => r.owner_withdraw === true)).to.equal(true);
        }
    });

    it('makes no decoder read for rows the raw stamp already decides', async function(){
        const db = fakeDb(LOW, { raw: INSTANT + 10 });
        const rows = [rowAt(500, INSTANT - 1), rowAt(501, INSTANT + 10, OPTED_IN)];
        await attachOwnerWithdrawRows(db, { coin: 'DOGE' }, rows, 'testnet');
        expect(db.windowReads).to.equal(0);
        expect(rows.map((r) => r.owner_withdraw)).to.deep.equal([true, true]);
        for(const network of ['mainnet', 'regtest']){
            const other = [rowAt(500, INSTANT + 10)];
            await attachOwnerWithdrawRows(db, { coin: 'DOGE' }, other, network);
            expect(db.windowReads, network).to.equal(0);
        }
    });

    it('applies to the getContracts post-pass and still drops meta_json', async function(){
        const db = fakeDb(LOW, { raw: INSTANT + 10 });
        const rows = [rowAt(500, INSTANT + 10), rowAt(501, INSTANT + 10, OPTED_IN)];
        await applyPostPasses(db, { data: { method: 'getContracts' } }, rows);
        expect(rows.map((r) => r.owner_withdraw)).to.deep.equal([true, true]);
        expect(db.windowReads).to.equal(1);
        expect(rows.every((r) => !('meta_json' in r))).to.equal(true);
    });
});
