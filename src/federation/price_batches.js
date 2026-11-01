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
const MEDIAN_TIME_SPAN            = 11;

// A round is a non-negative safe integer.
function isRound(v) {
    return Number.isSafeInteger(v) && v >= 0;
}

// A JSON number or a decimal-digit string as a number, anything else NaN. Typed
// before it is numbered, because Number() reads null, '', [] and false as 0 and '0x10' as 16.
function integerParam(v) {
    if (typeof v === 'number') return v;
    return (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : NaN;
}

// Validate the request. A limit above the ceiling is clamped rather than refused: a
// caller asking for more wants "as many as you will give me", not an error.
function validatePriceBatchParams(body) {
    body = body || {};
    let first = integerParam(body.first_round);
    let last  = integerParam(body.last_round);
    // Both ends of the range are rounds, in order
    if (!isRound(first)) return { ok: false, error: 'first_round must be a non-negative integer' };
    if (!isRound(last))  return { ok: false, error: 'last_round must be a non-negative integer' };
    if (first > last)    return { ok: false, error: 'first_round must not exceed last_round' };
    let limit = body.limit === undefined || body.limit === null ? PRICE_BATCHES_DEFAULT_LIMIT : integerParam(body.limit);
    // A supplied limit is a positive integer, capped at the ceiling
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'limit must be a positive integer' };
    if (limit > PRICE_BATCHES_MAX_LIMIT) limit = PRICE_BATCHES_MAX_LIMIT;
    return { ok: true, first_round: first, last_round: last, limit };
}

// A driver number, BigInt or digit string as a number; absent and invalid values as null.
function nullableNumber(v) {
    if (v === null || v === undefined || v === false) return null;
    let n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Resolve the protocol clock the indexer places in data['BLOCK_TIME']. Testnet uses
// the median of up to 11 preceding stored timestamps; other networks use the raw stamp.
async function protocolTimeForStoredBlock(db, dbConfig, network, blockIndex) {
    let raw = await db.getDecoderBlockTime(dbConfig, blockIndex);
    if (raw === null || raw === undefined || raw === false || network !== 'testnet') return raw;
    let previous = await db.getPreviousDecoderBlockTimes(dbConfig, blockIndex, MEDIAN_TIME_SPAN);
    let times = (Array.isArray(previous) ? previous : [])
        .slice(0, MEDIAN_TIME_SPAN).map(Number).filter(t => Number.isFinite(t) && t > 0)
        .sort((a, b) => a - b);
    if (times.length === 0) return raw;
    return Math.min(times[Math.floor(times.length / 2)], Number(raw));
}

// Resolve each distinct landing block once. Missing actions or block history stay null
// in the response rather than borrowing the tip clock or another batch's landing time.
async function landingBlockTimes(db, dbConfig, network, rows) {
    let times = new Map();
    for (const row of (Array.isArray(rows) ? rows : [])) {
        if (row.block_index === null || row.block_index === undefined) continue;
        let blockIndex = Number(row.block_index);
        if (!Number.isSafeInteger(blockIndex) || times.has(blockIndex)) continue;
        let time = await protocolTimeForStoredBlock(db, dbConfig, network, blockIndex);
        if (time !== false && time !== null && time !== undefined) times.set(blockIndex, Number(time));
    }
    return times;
}

// Map the rows to the response. `truncated` is true when the page filled, which tells
// the caller the range past the last batch is unanswered rather than empty.
function buildPriceBatchesResponse(latestBlockIndex, rows, v, blockTimes) {
    let list = Array.isArray(rows) ? rows : [];
    let times = blockTimes instanceof Map ? blockTimes : new Map();
    let batches = list.map(r => {
        let blockIndex = nullableNumber(r.block_index);
        let blockTime  = blockIndex === null ? null : nullableNumber(times.get(blockIndex));
        return {
            action_index: Number(r.action_index),
            first_round:  Number(r.batch_first_round),
            last_round:   Number(r.batch_last_round),
            round_count:  nullableNumber(r.round_count),
            block_index:  blockIndex,
            block_time:   blockTime
        };
    });
    return {
        block_index: latestBlockIndex === null || latestBlockIndex === undefined ? null : Number(latestBlockIndex),
        first_round: v.first_round,
        last_round:  v.last_round,
        batches:     batches,
        truncated:   batches.length >= v.limit
    };
}

// The method body: validate, read the tip and the overlapping valid batches, map.
async function getpricebatches({ db, dbConfig, chain }, {first_round, last_round, limit}) {
    let v = validatePriceBatchParams({ first_round, last_round, limit });
    if (!v.ok) return { error: v.error };
    try {
        let latest = await db.getMaxBlockIndex(dbConfig);
        let rows   = await db.getPriceBatchesOverlappingRange(dbConfig, 'valid', v.last_round, v.first_round, v.limit);
        let times  = await landingBlockTimes(db, dbConfig, chain && chain.NETWORK, rows);
        return buildPriceBatchesResponse(latest, rows, v, times);
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getpricebatches', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up price batches' };
    }
}

module.exports = {
    PRICE_BATCHES_DEFAULT_LIMIT, PRICE_BATCHES_MAX_LIMIT,
    validatePriceBatchParams, buildPriceBatchesResponse, getpricebatches
};
