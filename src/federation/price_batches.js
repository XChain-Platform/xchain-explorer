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
 * XChain Explorer - federation read: getpricebatches
 *
 * "Which oracle rounds in this range already ride a VALID PRICE batch on chain?"
 * A hub's batch publisher asks before re-proposing a buffered window, because its
 * own tables cannot tell it which rounds another hub already published. Ported
 * from the indexer (src/api/price_batch_query.js and the handler in
 * src/api/rpc/price_batches.js) with the checks, the clamp and the response shape
 * unchanged. Invalid batches are excluded on purpose: they do not carry their
 * rounds for a replaying node, so those windows are right to fill.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability');

const log = getLogger();

// Rows one answer may carry by default, and the most a caller may ask for. The caller
// pages by advancing first_round past the last batch when `truncated` is set.
const PRICE_BATCHES_DEFAULT_LIMIT = 500;
const PRICE_BATCHES_MAX_LIMIT     = 1000;

// A round is a non-negative safe integer.
function isRound(v) {
    return Number.isSafeInteger(v) && v >= 0;
}

// Validate the request. A limit above the ceiling is clamped rather than refused: a
// caller asking for more wants "as many as you will give me", not an error.
function validatePriceBatchParams(body) {
    body = body || {};
    let first = Number(body.first_round);
    let last  = Number(body.last_round);
    // Both ends of the range are rounds, in order
    if (!isRound(first)) return { ok: false, error: 'first_round must be a non-negative integer' };
    if (!isRound(last))  return { ok: false, error: 'last_round must be a non-negative integer' };
    if (first > last)    return { ok: false, error: 'first_round must not exceed last_round' };
    let limit = body.limit === undefined || body.limit === null ? PRICE_BATCHES_DEFAULT_LIMIT : Number(body.limit);
    // A supplied limit is a positive integer, capped at the ceiling
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'limit must be a positive integer' };
    if (limit > PRICE_BATCHES_MAX_LIMIT) limit = PRICE_BATCHES_MAX_LIMIT;
    return { ok: true, first_round: first, last_round: last, limit };
}

// Map the rows to the response. `truncated` is true when the page filled, which tells
// the caller the range past the last batch is unanswered rather than empty.
function buildPriceBatchesResponse(latestBlockIndex, rows, v) {
    let list = Array.isArray(rows) ? rows : [];
    let batches = list.map(r => ({
        action_index: Number(r.action_index),
        first_round:  Number(r.batch_first_round),
        last_round:   Number(r.batch_last_round),
        round_count:  r.round_count === null || r.round_count === undefined ? null : Number(r.round_count)
    }));
    return {
        block_index: latestBlockIndex === null || latestBlockIndex === undefined ? null : Number(latestBlockIndex),
        first_round: v.first_round,
        last_round:  v.last_round,
        batches:     batches,
        truncated:   batches.length >= v.limit
    };
}

// The method body: validate, read the tip and the overlapping valid batches, map.
async function getpricebatches({ db, dbConfig }, {first_round, last_round, limit}) {
    let v = validatePriceBatchParams({ first_round, last_round, limit });
    if (!v.ok) return { error: v.error };
    try {
        let latest = await db.getMaxBlockIndex(dbConfig);
        let rows   = await db.getPriceBatchesOverlappingRange(dbConfig, 'valid', v.last_round, v.first_round, v.limit);
        return buildPriceBatchesResponse(latest, rows, v);
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getpricebatches', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up price batches' };
    }
}

module.exports = {
    PRICE_BATCHES_DEFAULT_LIMIT, PRICE_BATCHES_MAX_LIMIT,
    validatePriceBatchParams, buildPriceBatchesResponse, getpricebatches
};
