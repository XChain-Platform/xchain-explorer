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
    buildPriceBatchesResponse
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
        for (const limit of [0, 1.5]) {
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
                { action_index: 21, first_round: 3, last_round: 5, round_count: 3 },
                { action_index: 22, first_round: 8, last_round: 11, round_count: null }
            ],
            truncated: true
        });
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
