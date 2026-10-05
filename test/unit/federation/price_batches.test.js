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
 *
 * Request validation and response mapping for the getpricebatches read.
 *
 * Pins the round and limit checks, the clamp to the ceiling, and the response
 * shape including the truncated flag.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { validatePriceBatchParams, buildPriceBatchesResponse,
        PRICE_BATCHES_DEFAULT_LIMIT, PRICE_BATCHES_MAX_LIMIT } = require('../../../src/federation/price_batches.js');

const FIRST_ERR = { ok: false, error: 'first_round must be a non-negative integer' };

describe('validatePriceBatchParams rounds', () => {
    it('refuses a missing body', () => {
        assert.deepStrictEqual(validatePriceBatchParams(), FIRST_ERR);
    });

    it('refuses a fractional first_round', () => {
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1.5, last_round: 4 }), FIRST_ERR);
    });

    it('refuses a negative last_round', () => {
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 1, last_round: -2 }),
            { ok: false, error: 'last_round must be a non-negative integer' });
    });

    it('refuses first_round above last_round', () => {
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: 7, last_round: 3 }),
            { ok: false, error: 'first_round must not exceed last_round' });
    });

    it('accepts string rounds as numbers with the default limit', () => {
        assert.deepStrictEqual(validatePriceBatchParams({ first_round: '1', last_round: '9' }),
            { ok: true, first_round: 1, last_round: 9, limit: PRICE_BATCHES_DEFAULT_LIMIT });
        assert.strictEqual(PRICE_BATCHES_DEFAULT_LIMIT, 500);
    });
});

describe('validatePriceBatchParams limit', () => {
    const range = { first_round: 1, last_round: 9 };

    it('defaults a null limit to 500', () => {
        assert.strictEqual(validatePriceBatchParams({ ...range, limit: null }).limit, 500);
    });

    it('keeps a limit within the ceiling', () => {
        assert.strictEqual(validatePriceBatchParams({ ...range, limit: 25 }).limit, 25);
    });

    it('clamps a limit above the ceiling', () => {
        const v = validatePriceBatchParams({ ...range, limit: 5000 });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.limit, 1000);
        assert.strictEqual(PRICE_BATCHES_MAX_LIMIT, 1000);
    });

    it('refuses a zero or fractional limit', () => {
        const err = { ok: false, error: 'limit must be a positive integer' };
        assert.deepStrictEqual(validatePriceBatchParams({ ...range, limit: 0 }), err);
        assert.deepStrictEqual(validatePriceBatchParams({ ...range, limit: 1.5 }), err);
    });
});

describe('buildPriceBatchesResponse', () => {
    const v = { first_round: 10, last_round: 40, limit: 2 };
    const rows = [
        { action_index: '3', batch_first_round: '10', batch_last_round: '19', round_count: '10' },
        { action_index: 4, batch_first_round: 20, batch_last_round: 29 }
    ];

    it('maps rows to numeric batches and flags a full page', () => {
        assert.deepStrictEqual(buildPriceBatchesResponse('12', rows, v), {
            block_index: 12,
            first_round: 10,
            last_round:  40,
            batches: [
                { action_index: 3, first_round: 10, last_round: 19, round_count: 10 },
                { action_index: 4, first_round: 20, last_round: 29, round_count: null }
            ],
            truncated: true
        });
    });

    it('leaves truncated false below the limit', () => {
        assert.strictEqual(buildPriceBatchesResponse(12, rows.slice(0, 1), v).truncated, false);
    });

    it('gives a null block_index for a missing tip', () => {
        assert.strictEqual(buildPriceBatchesResponse(null, rows, v).block_index, null);
        assert.strictEqual(buildPriceBatchesResponse(undefined, rows, v).block_index, null);
    });

    it('gives an empty untruncated list for non-array rows', () => {
        const res = buildPriceBatchesResponse(12, null, v);
        assert.deepStrictEqual(res.batches, []);
        assert.strictEqual(res.truncated, false);
    });
});
