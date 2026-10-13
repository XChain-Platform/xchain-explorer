'use strict';

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
 * Status codes for detail pages naming a record that cannot exist, and for
 * the 404 page reached by its own route.
 *
 * The routing harness's MockDB has no pools, so the freshness read and this
 * stage would both skip; each suite gives the explorer a pool and the two
 * readers the stage consults, so a pass means the check ran.
 */

const { expect, makeExplorer, request, state } = require('../routes/explorer_routing.test/support/helpers.js');

const { segwit } = require('./address_shape.test/support/address_encode.js');

const BTC_P2PKH  = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TX_HASH    = 'ab'.repeat(32);

// An explorer whose BTC pool reports a tip and an action high-water mark.
function useExplorer(opts = {}){
    before(function () {
        const explorer = makeExplorer();
        const calls = { maxAction: 0, maxBlock: 0 };
        explorer.db.pools = { BTC: {}, RBTC: {} };
        explorer.db.getCoinFreshness = async () => ({
            stale: !!opts.stale, tip_block: opts.tip === undefined ? 900000 : opts.tip,
            tip_age_seconds: 5, replica_halted: false
        });
        // The live tip runs one block ahead of the cached snapshot.
        explorer.db.getMaxBlockIndex = async () => {
            calls.maxBlock++;
            return 900001;
        };
        explorer.db.getMaxActionIndex = async () => {
            calls.maxAction++;
            if(opts.actionThrows) throw new Error('read failed');
            return 5000n;
        };
        state.explorer = explorer;
        state.calls = calls;
    });
}

async function statusOf(path){
    const { res } = await request(state.explorer, path);
    expect(res._redirect).to.equal(null);
    expect(res._body).to.be.a('string');
    return res._status;
}

describe('detail pages answer 404 when their record cannot exist', function () {
    describe('block', function () {
        useExplorer();
        it('answers 404 above the indexed tip', async function () {
            expect(await statusOf('/BTC/block/99999999999')).to.equal(404);
        });
        it('answers 200 at the tip and below it, without a live read', async function () {
            const before = state.calls.maxBlock;
            expect(await statusOf('/BTC/block/900000')).to.equal(200);
            expect(await statusOf('/BTC/block/1')).to.equal(200);
            expect(state.calls.maxBlock).to.equal(before);
        });
        it('answers 200 for a block indexed after the snapshot was taken', async function () {
            expect(await statusOf('/BTC/block/900001')).to.equal(200);
            expect(await statusOf('/BTC/block/900002')).to.equal(404);
        });
        it('answers 404 for a height that is not a decimal integer', async function () {
            expect(await statusOf('/BTC/block/abc')).to.equal(404);
            expect(await statusOf('/BTC/block/12x')).to.equal(404);
            expect(await statusOf('/BTC/block/-1')).to.equal(404);
        });
        it('compares heights past 2^53 exactly', async function () {
            expect(await statusOf('/BTC/block/9007199254740993')).to.equal(404);
        });
    });

    describe('block while the tip cannot be vouched for', function () {
        describe('stale tip', function () {
            useExplorer({ stale: true });
            it('leaves a height above it at 200', async function () {
                expect(await statusOf('/BTC/block/99999999999')).to.equal(200);
            });
        });
        describe('unknown tip', function () {
            useExplorer({ tip: null });
            it('leaves a height at 200', async function () {
                expect(await statusOf('/BTC/block/99999999999')).to.equal(200);
            });
        });
    });

    describe('action', function () {
        useExplorer();
        it('answers 404 above the highest action index', async function () {
            expect(await statusOf('/BTC/action/99999999')).to.equal(404);
        });
        it('answers 200 at and below it', async function () {
            expect(await statusOf('/BTC/action/5000')).to.equal(200);
            expect(await statusOf('/BTC/action/1')).to.equal(200);
        });
        it('answers 404 for an index that is not a decimal integer, without a read', async function () {
            const before = state.calls.maxAction;
            expect(await statusOf('/BTC/action/7junk')).to.equal(404);
            expect(state.calls.maxAction).to.equal(before);
        });
    });

    describe('action when the high-water read fails', function () {
        useExplorer({ actionThrows: true });
        it('leaves the page at 200', async function () {
            expect(await statusOf('/BTC/action/99999999')).to.equal(200);
        });
    });

    describe('transaction', function () {
        useExplorer();
        it('answers 404 for a query that is neither a hash nor a tx_index', async function () {
            expect(await statusOf('/BTC/transaction/deadbeef')).to.equal(404);
            expect(await statusOf('/BTC/transaction/' + TX_HASH + 'ff')).to.equal(404);
        });
        it('answers 200 for a 64-hex hash in either case and for a decimal index', async function () {
            expect(await statusOf('/BTC/transaction/' + TX_HASH)).to.equal(200);
            expect(await statusOf('/BTC/transaction/' + TX_HASH.toUpperCase())).to.equal(200);
            expect(await statusOf('/BTC/transaction/12345')).to.equal(200);
        });
    });

    describe('address', function () {
        useExplorer();
        it('answers 404 for a segment that is not an address on this coin', async function () {
            expect(await statusOf('/BTC/address/notanaddress')).to.equal(404);
            // A regtest bech32 address is well formed but belongs to another network.
            expect(await statusOf('/BTC/address/' + segwit('bcrt', 0, Buffer.alloc(20, 7)))).to.equal(404);
        });
        it('answers 200 for base58 and bech32 addresses on this coin', async function () {
            expect(await statusOf('/BTC/address/' + BTC_P2PKH)).to.equal(200);
            expect(await statusOf('/BTC/address/' + BTC_BECH32)).to.equal(200);
        });
    });

    describe('requests the check leaves alone', function () {
        useExplorer();
        it('a detail path with a segment past the record', async function () {
            expect(await statusOf('/BTC/block/99999999999/extra')).to.equal(200);
        });
        it('a detail type with no cheap check', async function () {
            expect(await statusOf('/BTC/token/NOSUCHTICK')).to.equal(200);
        });
        it('a supported coin this instance does not serve', async function () {
            expect(await statusOf('/LTC/block/99999999999')).to.equal(200);
        });
        it('the api route for the same record, which answers through its own reader', async function () {
            const { cfg } = await request(state.explorer, '/BTC/api/block/99999999999');
            expect(cfg.data.method).to.equal('getBlock');
        });
    });
});

describe('the 404 page', function () {
    useExplorer();
    it('answers 404 at its own /404 route', async function () {
        expect(await statusOf('/404')).to.equal(404);
    });
    it('answers 404 for a path no route claims', async function () {
        expect(await statusOf('/no/such/page/here')).to.equal(404);
    });
});
