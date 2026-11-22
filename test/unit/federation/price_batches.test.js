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
 **********************************************************************/

'use strict';

const assert = require('assert');

const {
    PRICE_BATCHES_DEFAULT_LIMIT,
    PRICE_BATCHES_MAX_LIMIT,
    validatePriceBatchParams,
    buildPriceBatchesResponse,
    getpricebatches
} = require('../../../src/federation/price_batches.js');

describe('price batch parameter validation', function () {
    it('rejects invalid round bounds', function () {
        assert.deepStrictEqual(validatePriceBatchParams(), {
            ok: false, error: 'first_round must be a non-negative integer'
        });
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1.5, last_round: 9 }), {
            ok: false, error: 'first_round must be a non-negative integer'
        });
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1, last_round: -2 }), {
            ok: false, error: 'last_round must be a non-negative integer'
        });
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 7, last_round: 3 }), {
            ok: false, error: 'first_round must not exceed last_round'
        });
        // Number() would read each of these as a round
        for (const round of [null, true, false, '', ' ', [], [1], '0x10', '1e3', '-1']) {
            assert.deepStrictEqual(validatePriceBatchParams({ first_round: round, last_round: 9 }), {
                ok: false, error: 'first_round must be a non-negative integer'
            }, JSON.stringify(round));
        }
    });

    it('normalizes string rounds and default limits', function () {
        const expected = { ok: true, first_round: 1, last_round: 9, limit: PRICE_BATCHES_DEFAULT_LIMIT };
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: '1', last_round: '9' }), expected);
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: '1', last_round: '9', limit: null }), expected);
        assert.strictEqual(PRICE_BATCHES_DEFAULT_LIMIT, 500);
    });

    it('clamps oversized limits and rejects invalid limits', function () {
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1, last_round: 9, limit: 5000 }), {
            ok: true, first_round: 1, last_round: 9, limit: PRICE_BATCHES_MAX_LIMIT
        });
        assert.strictEqual(PRICE_BATCHES_MAX_LIMIT, 1000);
        for (const limit of [0, 1.5, true, [5], '', '0x10']) {
            assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1, last_round: 9, limit }), {
                ok: false, error: 'limit must be a positive integer'
            });
        }
    });
});

describe('price batch response mapping', function () {
    const validation = { first_round: 3, last_round: 11, limit: 2 };

    it('maps numeric fields and reports a full page as truncated', function () {
        const rows = [
            { action_index: '21', batch_first_round: '3', batch_last_round: '5', round_count: '3' },
            { action_index: 22, batch_first_round: 8, batch_last_round: 11 }
        ];
        assert.deepStrictEqual(buildPriceBatchesResponse('12', rows, validation), {
            block_index: 12,
            first_round: 3,
            last_round: 11,
            batches: [
                { action_index: 21, first_round: 3, last_round: 5, round_count: 3, block_index: null, block_time: null },
                { action_index: 22, first_round: 8, last_round: 11, round_count: null, block_index: null, block_time: null }
            ],
            truncated: true
        });
    });

    it('carries each batch landing block and its resolved protocol time', function () {
        const rows = [
            { action_index: 21, batch_first_round: 3, batch_last_round: 5, round_count: 3, block_index: 90n },
            { action_index: 22, batch_first_round: 8, batch_last_round: 11, round_count: null, block_index: '91' }
        ];
        const response = buildPriceBatchesResponse(92, rows, validation, new Map([[90, 1700000900]]));
        assert.deepStrictEqual(response.batches.map(batch => [batch.block_index, batch.block_time]),
            [[90, 1700000900], [91, null]]);
    });

    it('maps absent latest block indexes to null', function () {
        for (const latest of [null, undefined]) {
            const response = buildPriceBatchesResponse(latest, [], validation);
            assert.strictEqual(response.block_index, null);
        }
    });

    it('maps non-array rows to an untruncated empty list', function () {
        assert.deepStrictEqual(buildPriceBatchesResponse(12, { length: 2 }, validation), {
            block_index: 12,
            first_round: 3,
            last_round: 11,
            batches: [],
            truncated: false
        });
    });
});

// A decoder blocks table as a height -> stamp map (a null stamp is a stored block with
// no time). Every decoder read the explorer could use is answered from it and counted:
// the page-wide window reader and the single-height readers alike, so a count that
// grows with the landing blocks shows whichever path made it.
function decoderTable(stamps) {
    const reads = { count: 0 };
    const sortedDesc = () => [...stamps.keys()].sort((a, b) => b - a);
    const db = {
        reads,
        // The window statement's semantics: per requested height, its own row and the
        // stamped rows below it, newest first, at most span + 1 rows
        getDecoderBlockTimeWindows: async (config, heights, span) => {
            reads.count++;
            const rowCount = span > 0 ? span + 1 : 1;
            const out = [];
            for (const h of heights) {
                sortedDesc().filter(i => i <= h && (i === h || stamps.get(i) !== null))
                    .slice(0, rowCount)
                    .forEach(i => out.push({ requested_block_index: BigInt(h), block_index: BigInt(i), block_time: stamps.get(i) }));
            }
            return out;
        },
        getDecoderBlockTime: async (config, h) => {
            reads.count++;
            return stamps.has(h) && stamps.get(h) !== null ? stamps.get(h) : null;
        },
        getPreviousDecoderBlockTimes: async (config, h, span) => {
            reads.count++;
            return sortedDesc().filter(i => i < h && stamps.get(i) !== null).slice(0, span).map(i => stamps.get(i));
        }
    };
    return db;
}

// The block_time a batch landing at `h` must answer, computed from the table directly.
function expectedTime(stamps, network, h) {
    if (!stamps.has(h) || stamps.get(h) === null) return null;
    const raw = stamps.get(h);
    if (network !== 'testnet') return raw;
    const prev = [...stamps.keys()].filter(i => i < h && stamps.get(i) !== null)
        .sort((a, b) => b - a).slice(0, 11).map(i => stamps.get(i)).sort((a, b) => a - b);
    return prev.length === 0 ? raw : Math.min(prev[Math.floor(prev.length / 2)], raw);
}

// One batch per row, spread over `distinct` landing blocks starting at height 1000.
function spreadRows(count, distinct) {
    return Array.from({ length: count }, (_, i) => ({
        action_index: i + 1, batch_first_round: i, batch_last_round: i, round_count: 1, block_index: 1000 + (i % distinct)
    }));
}

describe('price batch landing protocol time', function () {
    it('uses testnet median time and resolves each distinct landing block once', async function () {
        const calls = [];
        const rows = [
            { action_index: 21, batch_first_round: 3, batch_last_round: 5, round_count: 3, block_index: 90 },
            { action_index: 22, batch_first_round: 6, batch_last_round: 8, round_count: 3, block_index: 90 },
            { action_index: 23, batch_first_round: 9, batch_last_round: 11, round_count: 3, block_index: null }
        ];
        const previous = [1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100, 1000, 900];
        const db = {
            getMaxBlockIndex: async () => 92,
            getPriceBatchesOverlappingRange: async () => rows,
            getDecoderBlockTimeWindows: async (config, heights, span) => {
                calls.push(['window', config.coin, heights, span]);
                return [{ requested_block_index: 90n, block_index: 90n, block_time: 2000 }]
                    .concat(previous.map((t, i) => ({ requested_block_index: 90n, block_index: BigInt(89 - i), block_time: t })));
            }
        };
        const result = await getpricebatches(
            { db, dbConfig: { coin: 'TDOGE' }, chain: { NETWORK: 'testnet' } },
            { first_round: 3, last_round: 11 });
        assert.deepStrictEqual(result.batches.map(batch => [batch.block_index, batch.block_time]),
            [[90, 1400], [90, 1400], [null, null]]);
        assert.deepStrictEqual(calls, [['window', 'TDOGE', [90], 11]]);
    });

    it('uses the stored raw timestamp outside testnet', async function () {
        const calls = [];
        const db = {
            getMaxBlockIndex: async () => 92,
            getPriceBatchesOverlappingRange: async () => [
                { action_index: 21, batch_first_round: 3, batch_last_round: 5, round_count: 3, block_index: 90 }
            ],
            getDecoderBlockTimeWindows: async (config, heights, span) => {
                calls.push([heights, span]);
                return [{ requested_block_index: 90, block_index: 90, block_time: 2000 }];
            }
        };
        const result = await getpricebatches(
            { db, dbConfig: { coin: 'DOGE' }, chain: { NETWORK: 'mainnet' } },
            { first_round: 3, last_round: 5 });
        assert.strictEqual(result.batches[0].block_time, 2000);
        assert.deepStrictEqual(calls, [[[90], 0]]);
    });

    it('makes no decoder read when no batch carries a landing block', async function () {
        const db = Object.assign(decoderTable(new Map()), {
            getMaxBlockIndex: async () => 92,
            getPriceBatchesOverlappingRange: async () => [
                { action_index: 21, batch_first_round: 3, batch_last_round: 5, round_count: 3, block_index: null }
            ]
        });
        const result = await getpricebatches({ db, dbConfig: { coin: 'RDOGE' }, chain: { NETWORK: 'regtest' } },
            { first_round: 3, last_round: 5 });
        assert.strictEqual(result.batches[0].block_time, null);
        assert.strictEqual(db.reads.count, 0);
    });
});

describe('price batch decoder reads do not grow with the landing blocks', function () {
    // Heights 980..1219 are stored; 1003 has no stamp and 1007 is missing entirely, so the
    // median windows of the heights above them skip a row, and a batch at 1007 answers null.
    const stamps = new Map();
    for (let h = 980; h < 1220; h++) stamps.set(h, 1700000000 + h * 600 + ((h * 7919) % 900));
    stamps.set(1003, null);
    stamps.delete(1007);

    for (const network of ['regtest', 'testnet']) {
        const ceiling = 1;
        for (const distinct of [1, 20, 200]) {
            it(network + ': ' + distinct + ' distinct landing blocks cost at most ' + ceiling + ' decoder read', async function () {
                const rows = spreadRows(200, distinct);
                const db = Object.assign(decoderTable(stamps), {
                    getMaxBlockIndex: async () => 1300,
                    getPriceBatchesOverlappingRange: async () => rows
                });
                const result = await getpricebatches(
                    { db, dbConfig: { coin: 'RDOGE' }, chain: { NETWORK: network } },
                    { first_round: 0, last_round: 1000, limit: 1000 });
                assert.ok(db.reads.count <= ceiling, 'decoder reads ' + db.reads.count + ' for ' + distinct + ' blocks');
                assert.deepStrictEqual(result.batches.map(b => b.block_time),
                    rows.map(r => expectedTime(stamps, network, r.block_index)));
            });
        }

        it(network + ': twenty concurrent calls cost twenty times the per-call constant', async function () {
            const rows = spreadRows(200, 200);
            const db = Object.assign(decoderTable(stamps), {
                getMaxBlockIndex: async () => 1300,
                getPriceBatchesOverlappingRange: async () => rows
            });
            const ctx = { db, dbConfig: { coin: 'RDOGE' }, chain: { NETWORK: network } };
            const results = await Promise.all(Array.from({ length: 20 },
                () => getpricebatches(ctx, { first_round: 0, last_round: 1000, limit: 1000 })));
            assert.ok(db.reads.count <= 20 * ceiling, 'decoder reads ' + db.reads.count + ' for a 20-call batch');
            assert.ok(results.every(r => Array.isArray(r.batches) && r.batches.length === 200));
        });
    }

    it('answers null for a missing block and the raw stamp for a block with no stamped history', async function () {
        const lone = new Map([[50, 1700000050]]);
        const db = Object.assign(decoderTable(lone), {
            getMaxBlockIndex: async () => 60,
            getPriceBatchesOverlappingRange: async () => [
                { action_index: 1, batch_first_round: 1, batch_last_round: 1, round_count: 1, block_index: 50 },
                { action_index: 2, batch_first_round: 2, batch_last_round: 2, round_count: 1, block_index: 51 }
            ]
        });
        const result = await getpricebatches({ db, dbConfig: { coin: 'TDOGE' }, chain: { NETWORK: 'testnet' } },
            { first_round: 0, last_round: 9 });
        assert.deepStrictEqual(result.batches.map(b => b.block_time), [1700000050, null]);
    });
});

describe('decoder block-time window reader', function () {
    const { getDecoderBlockTimeWindows } = require('../../../src/db/readers/federation_reads.js');

    function readerDb(answer) {
        const calls = [];
        return {
            calls,
            decoderDb: { RDOGE: 'xchain_decoder_rdoge', BAD: 'bad name;' },
            doDecoderQuery: async (config, sql, args) => { calls.push({ sql, args }); return answer(sql, args); }
        };
    }

    it('reads a whole page of heights in one bound statement', async function () {
        const db = readerDb(() => [{ requested_block_index: 7n, block_index: 7n, block_time: 1 }]);
        const rows = await getDecoderBlockTimeWindows.call(db, { coin: 'RDOGE' }, [7, 9, 7, '9', 12], 11);
        assert.strictEqual(db.calls.length, 1);
        assert.deepStrictEqual(db.calls[0].args, [7, 7, 7, 9, 9, 9, 12, 12, 12]);
        assert.strictEqual(db.calls[0].sql.split('UNION ALL').length, 3);
        assert.ok(/`xchain_decoder_rdoge`\.blocks/.test(db.calls[0].sql));
        assert.ok(/LIMIT 12\)/.test(db.calls[0].sql));
        assert.deepStrictEqual(rows, [{ requested_block_index: 7n, block_index: 7n, block_time: 1 }]);
    });

    it('reads only the landing row when no history is asked for', async function () {
        const db = readerDb(() => []);
        await getDecoderBlockTimeWindows.call(db, { coin: 'RDOGE' }, [7], 0);
        assert.ok(/LIMIT 1\)/.test(db.calls[0].sql));
    });

    it('makes no read for no heights or an unknown or unsafe decoder DB, and yields no rows on a failed read', async function () {
        const db = readerDb(() => { throw new Error('connection dropped'); });
        assert.deepStrictEqual(await getDecoderBlockTimeWindows.call(db, { coin: 'RDOGE' }, [], 11), []);
        assert.deepStrictEqual(await getDecoderBlockTimeWindows.call(db, { coin: 'RDOGE' }, [-1, 1.5, 'x'], 11), []);
        assert.deepStrictEqual(await getDecoderBlockTimeWindows.call(db, { coin: 'NONE' }, [7], 11), []);
        assert.deepStrictEqual(await getDecoderBlockTimeWindows.call(db, { coin: 'BAD' }, [7], 11), []);
        assert.strictEqual(db.calls.length, 0);
        assert.deepStrictEqual(await getDecoderBlockTimeWindows.call(db, { coin: 'RDOGE' }, [7], 11), []);
        assert.strictEqual(db.calls.length, 1);
    });
});
