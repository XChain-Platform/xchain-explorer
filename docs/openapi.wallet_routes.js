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
 * OpenAPI entries for the wallet range reads, in the SPECIAL-table shape
 * openapi.build.js consumes: POST /{COIN}/api/history (batch address history)
 * and GET /{COIN}/api/price_history (downsampled price series).
 *
 ********************************************************************/

'use strict';

const ERROR_BODY = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
const RATE_LIMITED = { description: 'Too many batch requests from this client; retry after the window', content: ERROR_BODY };

// Chain indices are decimal strings, as on every other REST surface.
const INDEX = { type: 'string', pattern: '^[0-9]+$' };
const NULLABLE_INDEX = { type: ['string', 'null'], pattern: '^[0-9]+$' };

const AMOUNT = (what) => ({ type: ['string', 'null'], description: what + ', an exact decimal string; null when the token has no decimals on record' });

const HISTORY_EFFECT = {
    type: 'object',
    description: 'What one action did to one requested address\'s balance of one token (credits minus debits; escrowed amounts are already debited)',
    properties: {
        address:     { type: 'string' },
        tick:        { type: ['string', 'null'] },
        decimals:    { type: ['integer', 'null'], description: 'The token\'s decimal places: base = whole x 10^decimals' },
        credit_base: AMOUNT('Credited, in base units'),
        debit_base:  AMOUNT('Debited, in base units'),
        net_base:    AMOUNT('credit_base minus debit_base. An integer except where the ledger holds a fee finer than the token (a half-unit fee on a 0-decimal gas token reads -0.5). Summed exactly over an address\'s whole history it equals the stored balance x 10^decimals: the ledger and the balance both hold exact amounts, with no rounding to the token\'s decimals'),
        net_whole:   { type: 'string', description: 'The same net in whole token units' },
    },
    required: ['address', 'tick', 'decimals', 'credit_base', 'debit_base', 'net_base', 'net_whole'],
};

const HISTORY_ACTION = {
    type: 'object',
    description: 'One confirmed action, with the GET /history/{address}/address feed columns. Per-action details and status are served by GET /action/{ACTION_INDEX}',
    properties: {
        action_index: INDEX,
        action:       { type: ['string', 'null'], description: 'Action name, including the transaction-less ledger actions (DISPENSE, ORDER_MATCH, DIVIDEND, SWEEP, ...)' },
        block_index:  NULLABLE_INDEX,
        timestamp:    Object.assign({ description: 'Block time, unix seconds' }, NULLABLE_INDEX),
        tx_hash:      { type: ['string', 'null'], description: 'null for a transaction-less action' },
        tx_index:     NULLABLE_INDEX,
        parent_batch_action_index: NULLABLE_INDEX,
        addresses:    { type: 'array', items: { type: 'string' }, description: 'The requested addresses this action is mapped to' },
        effects:      { type: 'array', items: HISTORY_EFFECT },
    },
};

const HISTORY_RESPONSE = {
    type: 'object',
    properties: {
        amount_unit: { type: 'string', enum: ['base'], description: 'Unit of every *_base field' },
        addresses:   { type: 'array', items: { type: 'string' }, description: 'The requested addresses, canonical spelling, request order' },
        limit:       { type: 'integer' },
        before:      { type: ['integer', 'null'] },
        since:       { type: ['integer', 'null'] },
        until:       { type: ['integer', 'null'] },
        next_cursor: { type: ['string', 'null'], pattern: '^[0-9]+$', description: 'Pass as `before` for the next page; null on the last page' },
        actions:     { type: 'array', items: HISTORY_ACTION, description: 'Newest first; one entry per action however many requested addresses it touched' },
    },
    required: ['amount_unit', 'addresses', 'limit', 'next_cursor', 'actions'],
};

const PRICE_POINT = {
    type: 'object',
    properties: {
        t:     { type: 'integer', description: 'Bucket start, unix seconds, on a UTC interval boundary' },
        price: { type: 'string', description: 'The last price inside the bucket, quote units per 1 whole unit of the asset' },
        at:    { type: 'integer', description: 'When that price was set: the oracle round\'s block_timestamp, or the bucket\'s latest fill block time' },
        fills: { type: 'integer', description: 'DEX series only: valid fills inside the bucket' },
    },
    required: ['t', 'price', 'at'],
};

const PRICE_SERIES = {
    type: 'object',
    properties: {
        asset:  { type: 'string' },
        source: { type: 'string', enum: ['oracle', 'dex'], description: 'oracle: finalized price_snapshots rounds (hub mirror). dex: valid order_matches fills' },
        pair:   { type: 'string', description: 'ASSET/FIAT for oracle, ASSET/QUOTE for dex' },
        quote:  { type: 'string', description: 'What the price is counted in' },
        points: { type: 'array', items: PRICE_POINT, description: 'Ascending by t; a bucket with no price has no point (no carry-forward, no zero fill)' },
    },
    required: ['asset', 'source', 'pair', 'quote', 'points'],
};

const SOURCE_STATE = {
    type: 'object',
    properties: { available: { type: 'boolean' }, code: { type: 'string', description: 'Why the source is unavailable (hub-mirror gate code or ORACLE_SOURCE_NOT_CONFIGURED)' } },
    required: ['available'],
};

const PRICE_RESPONSE = {
    type: 'object',
    properties: {
        interval:         { type: 'string', enum: ['hour', 'day'] },
        interval_seconds: { type: 'integer' },
        from:             { type: 'integer', description: 'First bucket start (from, rounded down to the interval)' },
        to:               { type: 'integer', description: 'Last second of the last bucket' },
        fiat:             { type: 'string' },
        quote:            { type: 'string' },
        price_unit:       { type: 'string' },
        sources:          { type: 'object', properties: { oracle: SOURCE_STATE, dex: SOURCE_STATE } },
        series:           { type: 'array', items: PRICE_SERIES, description: 'Request order; an asset can have one series per source' },
        missing:          { type: 'array', items: { type: 'string' }, description: 'Requested assets with no data in any source' },
    },
    required: ['interval', 'interval_seconds', 'from', 'to', 'fiat', 'quote', 'price_unit', 'sources', 'series', 'missing'],
};

const NATIVE_HISTORY_RESPONSE = {
    type: 'object',
    description: 'The tracker\'s answer, unchanged. Amounts are base-unit decimal strings',
    properties: {
        transactions: { type: 'array', items: { type: 'object', properties: {
            txid: { type: 'string' }, height: { type: 'integer' }, time: { type: 'integer' }, net: { type: 'string' },
            addresses: { type: 'object', additionalProperties: { type: 'object', properties: {
                received: { type: 'string' }, sent: { type: 'string' }, net: { type: 'string' } } } },
        } } },
        cursor:              { type: ['string', 'null'] },
        addresses:           { type: 'object', description: 'Per requested address: its watch state on the tracker',
            additionalProperties: { type: 'object', properties: {
                history_status:      { type: 'string', enum: ['complete', 'backfilling', 'not_watched', 'unavailable'] },
                history_from_height: { type: ['integer', 'null'], description: 'Rows from this height are present' },
                history_refused:     { type: 'string', description: 'With not_watched: WATCH_LIST_FULL, IP_BUDGET or COOLDOWN' },
            } } },
        history_from_height: { type: ['integer', 'null'] },
        sync:                { type: 'object' },
    },
};

const WALLET_RANGE_ROUTES = [
    // Shares the path of the GET history list, so its prose rides on the POST
    // operation itself rather than the entry's description slot (which lands on GET).
    ['/{COIN}/api/history', 'Core',
        'Merged confirmed action history with per-address balance effects for up to 20 addresses in one request',
        null,
        {
            noGet: true,
            schema: HISTORY_RESPONSE,
            responses: { 429: RATE_LIMITED },
            post: {
                operationId: 'post_history',
                description: 'One newest-first page across every requested address, complete over the action_index span it covers. '
                    + 'Runs a fixed number of statements however many addresses or rows it serves. `since`/`until` resolve to whole blocks: '
                    + 'every block after the last block stamped before `since`, through the last block stamped at or before `until`.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    addresses: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Addresses to read (duplicates collapsed, order kept); more than 20 answers 400 TOO_MANY_ADDRESSES' },
                                    limit:     { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Actions per page; outside 1..100 answers 400 INVALID_LIMIT' },
                                    before:    { type: ['integer', 'string'], pattern: '^[0-9]+$', description: 'Cursor: the previous page\'s next_cursor (exclusive)' },
                                    since:     { type: 'integer', minimum: 0, description: 'Window start, unix seconds' },
                                    until:     { type: 'integer', minimum: 0, description: 'Window end, unix seconds' },
                                },
                                required: ['addresses'],
                            },
                        },
                    },
                },
            },
        }],
    ['/{COIN}/api/price_history', 'Prices',
        'Downsampled price series for up to 50 assets: oracle rounds in fiat and DEX fills in the quote coin, each series naming its source',
        'One statement per source however many assets. A point is the last price inside its UTC-aligned bucket; empty buckets have no point, '
            + 'and an asset with no data is listed in `missing` with no series. A range over 1000 buckets answers 400 RANGE_TOO_LARGE.',
        {
            schema: PRICE_RESPONSE,
            responses: { 429: RATE_LIMITED },
            query: [
                { name: 'assets', required: true, schema: { type: 'string' },
                  description: 'Comma-separated tickers, at most 50. Repeat the parameter instead (assets=A&assets=B) to name a ticker containing a comma; repeated values are not split' },
                { name: 'interval', required: false, schema: { type: 'string', enum: ['hour', 'day'], default: 'day' } },
                { name: 'from', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Unix seconds; default 7 days (hour) or 365 days (day) before `to`' },
                { name: 'to', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Unix seconds; default now' },
                { name: 'fiat', required: false, schema: { type: 'string', default: 'USD' }, description: 'Fiat code for the oracle pair ASSET/FIAT' },
                { name: 'quote', required: false, schema: { type: 'string' }, description: 'DEX quote side; default this chain\'s native coin (BTC, LTC, DOGE)' },
            ],
        }],
    ['/{COIN}/api/native_history', 'Core',
        'Confirmed native coin history for up to 20 addresses, passed through to this coin\'s UTXO tracker POST /history',
        null,
        {
            noGet: true,
            schema: NATIVE_HISTORY_RESPONSE,
            responses: {
                429: RATE_LIMITED,
                502: { description: 'TRACKER_UNAVAILABLE: the tracker did not answer (retryable)', content: ERROR_BODY },
                503: { description: 'COIN_NOT_AVAILABLE, TRACKER_NOT_CONFIGURED, or TRACKER_UNAVAILABLE while the tracker is over this client\'s budget or paused by its own 429', content: ERROR_BODY },
            },
            post: {
                operationId: 'post_native_history',
                description: 'One upstream call per request. The address list is checked here (at most 20, canonical spelling); every other field is judged by the tracker, '
                    + 'and its answer, refusals included (503 NOT_READY before the tracker has indexed a block), is returned with its status, body and the '
                    + 'X-Next-Cursor / X-Tracker-Height / X-Synced family of headers. The caller\'s address, as this explorer resolves it, goes to the tracker in '
                    + 'X-Forwarded-For so its per-IP watch budget is per wallet; a client\'s own X-Forwarded-For is never forwarded.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    addresses:   { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
                                    from_height: { type: 'integer', minimum: 0 },
                                    to_height:   { type: 'integer', minimum: 0 },
                                    from_time:   { type: 'integer', minimum: 0, description: 'Unix seconds' },
                                    to_time:     { type: 'integer', minimum: 0, description: 'Unix seconds' },
                                    limit:       { type: 'integer', minimum: 1 },
                                    cursor:      { type: 'string', description: 'The previous page\'s cursor' },
                                },
                                required: ['addresses'],
                            },
                        },
                    },
                },
            },
        }],
];

module.exports = { WALLET_RANGE_ROUTES };
