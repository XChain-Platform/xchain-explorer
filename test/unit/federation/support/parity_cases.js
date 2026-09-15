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
 * The request and row fixtures the federation parity suite runs through both the
 * explorer's methods and the indexer's own handlers. Each case is
 * { name, params, scenario, coin? }; `coin` defaults to testnet DOGE. The rows
 * mix BigInt, string and number columns on purpose, because the explorer's pool
 * returns BIGINT as BigInt where the indexer's returns Number.
 *
 ********************************************************************/

'use strict';

const K1 = 'a'.repeat(64), K2 = 'B'.repeat(64), K3 = 'c'.repeat(64);
const TX_A = 'ab'.repeat(32), TX_C = 'cd'.repeat(32);

const SIGNER_ROWS = [
    { epoch_height: 100, pubkey: K1.toUpperCase(), sig: 'DEAD'.repeat(32), ledger_hash: 'BEEF'.repeat(16),
      publisher: K3.toUpperCase(), action_index: 7n, block_index: '470', gates: null },
    { epoch_height: 100, pubkey: K2, sig: 'f00d'.repeat(32), ledger_hash: 'beef'.repeat(16),
      publisher: K3, action_index: 9, block_index: 475, gates: 'vm.CALL,vm.DEPLOY' }
];
const ROLLCALL = { tip: 500, tipTime: 1789000000, hcut: 480, signers: SIGNER_ROWS,
                   publishers: [{ publisher: K3.toUpperCase(), action_index: 7n, block_index: 470 }] };
const ROLLCALL_PARAMS = { network: 'testnet', epoch_height: 100, max_block_time: 1789000100,
                          pubkeys: [K1, K2, 'xyz', 5], publishers: [K3] };

const ROLLCALL_CASES = [
    { name: 'a window with signers and a publisher', params: ROLLCALL_PARAMS, scenario: ROLLCALL },
    { name: 'no network named', params: Object.assign({}, ROLLCALL_PARAMS, { network: undefined }), scenario: ROLLCALL },
    { name: 'no window cut yet', params: ROLLCALL_PARAMS, scenario: Object.assign({}, ROLLCALL, { hcut: null }) },
    { name: 'no tip block time', params: ROLLCALL_PARAMS, scenario: Object.assign({}, ROLLCALL, { tipTime: undefined }) },
    { name: 'a network mismatch', params: Object.assign({}, ROLLCALL_PARAMS, { network: 'mainnet' }), scenario: ROLLCALL },
    { name: 'a negative epoch', params: Object.assign({}, ROLLCALL_PARAMS, { epoch_height: -1 }), scenario: ROLLCALL },
    { name: 'a non-numeric window end', params: Object.assign({}, ROLLCALL_PARAMS, { max_block_time: 'soon' }), scenario: ROLLCALL },
    { name: 'a key list past the ceiling',
      params: Object.assign({}, ROLLCALL_PARAMS, { pubkeys: Array.from({ length: 2049 }, (_, i) => i.toString(16).padStart(64, '0')) }),
      scenario: ROLLCALL },
    { name: 'empty key lists', params: Object.assign({}, ROLLCALL_PARAMS, { pubkeys: [], publishers: 'nope' }), scenario: ROLLCALL },
    { name: 'a failed signer read', params: ROLLCALL_PARAMS, scenario: Object.assign({}, ROLLCALL, { throwOn: 'signers' }) },
    { name: 'a non-DOGE coin', params: ROLLCALL_PARAMS, scenario: ROLLCALL, coin: { code: 'TBTC', COIN: 'BTC', NETWORK: 'testnet' } }
];

function anchorRow(over) {
    return Object.assign({ action_index: 90, version: 0, chain: 'BTC', network: 'testnet', block_index: 1000n,
        block_hash: 'bh', ledger_hash: 'lh', actions_hash: 'ah', contract_hash: 'ch', checkpoint_seq: 3,
        snapshot_block: 999, state_root: 'sr', state_root_version: 2, block_merkle_root: null,
        block_merkle_version: null, block_index_doge: 450, status: 'valid', txid: TX_A.toUpperCase() }, over);
}
const ANCHORS = { tip: 500, anchorCandidates: [
    anchorRow({}),
    anchorRow({ action_index: 95, version: 1, block_index_doge: 490, status: 'unverified', txid: TX_C, state_root: null,
                block_merkle_root: 'mr', block_merkle_version: 'x' })
] };
const ACTION_PARAMS = { chain: 'BTC', network: 'testnet', block_index: 1000, checkpoint_seq: 3 };

const ACTION_CASES = [
    { name: 'an unfiltered ask on a shared key', params: ACTION_PARAMS, scenario: ANCHORS },
    { name: 'a version 1 filter', params: Object.assign({}, ACTION_PARAMS, { version: 1 }), scenario: ANCHORS },
    { name: 'a txid filter that only the archive head carries', params: Object.assign({}, ACTION_PARAMS, { txid: TX_C.toUpperCase() }), scenario: ANCHORS },
    { name: 'a txid and version that match nothing', params: Object.assign({}, ACTION_PARAMS, { txid: TX_A, version: '1' }), scenario: ANCHORS },
    { name: 'an archive head arriving ahead of the section', params: ACTION_PARAMS,
      scenario: { tip: 500, anchorCandidates: ANCHORS.anchorCandidates.slice().reverse() } },
    { name: 'no candidates', params: ACTION_PARAMS, scenario: { tip: 500, anchorCandidates: [] } },
    { name: 'a row above the tip', params: ACTION_PARAMS, scenario: { tip: 400, anchorCandidates: [anchorRow({})] } },
    { name: 'a missing chain', params: Object.assign({}, ACTION_PARAMS, { chain: '' }), scenario: ANCHORS },
    { name: 'a negative height', params: Object.assign({}, ACTION_PARAMS, { block_index: -1 }), scenario: ANCHORS },
    { name: 'a malformed txid', params: Object.assign({}, ACTION_PARAMS, { txid: 'zz' }), scenario: ANCHORS },
    { name: 'a version with no checkpoint identity', params: Object.assign({}, ACTION_PARAMS, { version: 2 }), scenario: ANCHORS },
    { name: 'a failed candidate read', params: ACTION_PARAMS, scenario: Object.assign({}, ANCHORS, { throwOn: 'anchorCandidates' }) }
];

function txidRow(action, section, over) {
    return Object.assign({ action_index: action, section_index: section, version: 0, chain: 'BTC', network: 'testnet',
        block_index: 1000 + action, checkpoint_seq: action, snapshot_block: null, publisher: 'AA'.repeat(33),
        match_batch_seq: null, block_index_doge: 400 + action, status: 'valid', txid: TX_A }, over);
}
// 19 single-row actions then one two-section action: the probe row shares the last kept row's action.
const TRUNCATED = { tip: 500, txidRows: Array.from({ length: 19 }, (_, i) => txidRow(i + 1, 0))
    .concat([txidRow(20, 0), txidRow(20, 1)]) };
const SMALL = { tip: 500, txidRows: [txidRow(4, 0, { version: null, block_index: null, publisher: null }),
    txidRow(4, 1, { status: 'invalid: bad', block_index_doge: 900 }), txidRow(8, 0, { action_index: 8n, version: 1, match_batch_seq: 12n })] };

const CONFIRMATION_CASES = [
    { name: 'a small set', params: { txid: TX_A.toUpperCase() }, scenario: SMALL },
    { name: 'a truncated page cut on an action boundary', params: { txid: TX_A }, scenario: TRUNCATED },
    { name: 'a page one action cannot be cut from', params: { txid: TX_A },
      scenario: { tip: 500, txidRows: Array.from({ length: 21 }, (_, i) => txidRow(7, i)) } },
    { name: 'a numeric cursor', params: { txid: TX_A, after_action_index: 5 }, scenario: SMALL },
    { name: 'a digit-string cursor', params: { txid: TX_A, after_action_index: '5' }, scenario: SMALL },
    { name: 'an array cursor', params: { txid: TX_A, after_action_index: [] }, scenario: SMALL },
    { name: 'a boolean cursor', params: { txid: TX_A, after_action_index: true }, scenario: SMALL },
    { name: 'a fractional cursor', params: { txid: TX_A, after_action_index: 1.5 }, scenario: SMALL },
    { name: 'a malformed txid', params: { txid: 'nope' }, scenario: SMALL },
    { name: 'no rows', params: { txid: TX_A }, scenario: { tip: 500, txidRows: [] } },
    { name: 'a failed row read', params: { txid: TX_A }, scenario: Object.assign({}, SMALL, { throwOn: 'txidRows' }) }
];

function headRow(over) {
    return Object.assign({ action_index: 10, version: 1, chain: 'BTC', network: 'testnet', block_index: 1000,
        checkpoint_seq: 3, snapshot_block: 999n, match_batch_seq: 12n, match_count: 4, batch_crc32: 'DEADBEEF',
        total_chunks: 3, block_index_doge: 440, status: 'valid', source: 'nAuthorOne', txid: 'EF'.repeat(32) }, over);
}
const ARCHIVE = { tip: 500, heads: [headRow({}), headRow({ action_index: 11, source: 'nAuthorTwo', total_chunks: 'x' })],
    chunks: [{ chunk_index: 1, action_index: 20 }, { chunk_index: 1, action_index: 21 }, { chunk_index: 2n, action_index: 22 }] };
const ARCHIVE_PARAMS = { chain: 'BTC', network: 'testnet', block_index: 1000, checkpoint_seq: 3,
                         batch_crc32: 'DEADBEEF', match_count: 4 };

const ARCHIVE_CASES = [
    { name: 'the earliest head with its chunks', params: ARCHIVE_PARAMS, scenario: ARCHIVE },
    { name: 'an author-scoped head', params: Object.assign({}, ARCHIVE_PARAMS, { author: 'nAuthorTwo' }), scenario: ARCHIVE },
    { name: 'an author with no head', params: Object.assign({}, ARCHIVE_PARAMS, { author: 'nobody' }), scenario: ARCHIVE },
    { name: 'an author differing only in case', params: Object.assign({}, ARCHIVE_PARAMS, { author: 'nauthortwo' }), scenario: ARCHIVE },
    { name: 'a head whose author did not resolve', params: ARCHIVE_PARAMS,
      scenario: { tip: 500, heads: [headRow({ source: null })], chunks: ARCHIVE.chunks } },
    { name: 'a head with a stray chunk index', params: ARCHIVE_PARAMS,
      scenario: Object.assign({}, ARCHIVE, { chunks: ARCHIVE.chunks.concat([{ chunk_index: 5, action_index: 23 }]) }) },
    { name: 'no head', params: ARCHIVE_PARAMS, scenario: { tip: 500, heads: [] } },
    { name: 'a malformed crc', params: Object.assign({}, ARCHIVE_PARAMS, { batch_crc32: 'xyz' }), scenario: ARCHIVE },
    { name: 'a numeric crc', params: Object.assign({}, ARCHIVE_PARAMS, { batch_crc32: 123 }), scenario: ARCHIVE },
    { name: 'a negative match count', params: Object.assign({}, ARCHIVE_PARAMS, { match_count: -1 }), scenario: ARCHIVE },
    { name: 'a non-string author', params: Object.assign({}, ARCHIVE_PARAMS, { author: 5 }), scenario: ARCHIVE },
    { name: 'a failed chunk read', params: ARCHIVE_PARAMS, scenario: Object.assign({}, ARCHIVE, { throwOn: 'chunks' }) }
];

const PRICES = { tip: 500, prices: [{ action_index: 5n, batch_first_round: 10, batch_last_round: 11n, round_count: 2 },
    { action_index: 6, batch_first_round: '12', batch_last_round: 13, round_count: null }] };

const PRICE_CASES = [
    { name: 'a range with batches', params: { first_round: 0, last_round: 100 }, scenario: PRICES },
    { name: 'a filled page', params: { first_round: '0', last_round: '100', limit: 2 }, scenario: PRICES },
    { name: 'a limit above the ceiling', params: { first_round: 0, last_round: 100, limit: 5000 }, scenario: PRICES },
    { name: 'a zero limit', params: { first_round: 0, last_round: 100, limit: 0 }, scenario: PRICES },
    { name: 'a reversed range', params: { first_round: 9, last_round: 3 }, scenario: PRICES },
    { name: 'a negative round', params: { first_round: -1, last_round: 3 }, scenario: PRICES },
    { name: 'a missing range', params: {}, scenario: PRICES },
    { name: 'a failed batch read', params: { first_round: 0, last_round: 1 }, scenario: Object.assign({}, PRICES, { throwOn: 'prices' }) }
];

module.exports = { ROLLCALL_CASES, ACTION_CASES, CONFIRMATION_CASES, ARCHIVE_CASES, PRICE_CASES };
