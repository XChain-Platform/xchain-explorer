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
 * Serve-side FILE payload decompression.
 *
 * The explorer is a READER, and readers face hostile input: COMPRESSION is
 * sender-asserted and unverified, so a lying field is trivially craftable by
 * anyone willing to pay for one transaction. Everything here follows from
 * that:
 *
 *  - FAIL-CLOSED (§5.5). If the bytes are not a valid deflate stream, or any
 *    guard trips, serve the STORED bytes with an explicit stored-form
 *    indicator. Partially inflated output is never served, and a lying field
 *    must never crash the server.
 *  - STREAMED, RATIO-BOUNDED (§5.5). The 150:1 cap is enforced as a streamed
 *    abort so a compression bomb stops being read the moment it exceeds the
 *    ceiling, rather than being fully allocated and measured afterwards.
 *  - DERIVED FROM THE ACTION STRING, never a parsed-at-ingest column (§5.1).
 *    Shipped indexers drop unknown trailing fields at parse, so a compressed
 *    FILE mined before an indexer upgrade would be stored marker-less and
 *    served as deflated garbage forever if we trusted a column. The decoder
 *    preserves the full action string, so serve-time derivation always works.
 *  - NEVER INFLATE GATED CIPHERTEXT (§5.4). On a token-gated FILE,
 *    COMPRESSION=1 means inflate-AFTER-decrypt, client-side only. The
 *    explorer has no key and must always serve gated bytes exactly as stored.
 *
 * Vendored rather than imported from xchain-sdk: the services ship as
 * independent containers with no shared node_modules tree.
 *
 ********************************************************************/

'use strict';

const zlib = require('zlib');

// Vendored byte-identical from xchain-documentation/protocol/constants.js.
const COMPRESSION_CODE_DEFLATE_RAW = '1';
const COMPRESSION_MAX_RATIO = 150;

// FILE v0 field indices in the FULL action string (ACTION token included):
// FILE|0|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
const GATE_TICKER_FIELD_INDEX = 6;
const COMPRESSION_FIELD_INDEX = 10;

// Unwrap a BATCH-wrapped FILE to its own sub-command, or hand the string back
// unchanged. A FILE may legally ride inside a BATCH (protocol actions/file.md),
// and what the serve path reads is the DECODER's tx-level `data` column, so the
// stored string is then `BATCH|<v>|FILE|0|...;...` and the FILE-prefix gates
// below would read `BATCH` and pass deflated bytes through as raw.
//
// Splitting on ';' and then '|' IS how consensus reads a BATCH
// (xchain-indexer/src/actions/batch.js splits TX_DATA on ';' and each command on
// '|'), so no field of an on-chain-valid FILE can carry either delimiter; a
// BATCH carries at most one FILE, since a transaction carries one rawData
// payload (protocol actions/batch.md). Fail-closed: with no FILE sub-command
// found the string is returned untouched, the gates read false, and the caller
// serves the stored bytes exactly as before.
function extractFileSubcommand(actionString) {
    if (typeof actionString !== 'string' || actionString.length === 0) return actionString;
    const parts = actionString.split('|');
    if (String(parts[0]).toUpperCase() !== 'BATCH') return actionString;
    // Drop the BATCH|<VERSION>| prefix, then take the first FILE command.
    for (const command of parts.slice(2).join('|').split(';')) {
        if (String(command.split('|')[0]).toUpperCase() === 'FILE') return command;
    }
    return actionString;
}

// Does this FILE v0 action string declare deflate-raw? Lenient by design:
// anything that is not exactly the known code reads as raw, so an unknown
// future code degrades safely instead of erroring.
function isCompressedAction(actionString) {
    if (typeof actionString !== 'string' || actionString.length === 0) return false;
    const parts = extractFileSubcommand(actionString).split('|');
    if (parts.length <= COMPRESSION_FIELD_INDEX) return false;
    if (String(parts[0]).toUpperCase() !== 'FILE') return false;
    if (String(parts[1]) !== '0') return false;
    return String(parts[COMPRESSION_FIELD_INDEX]) === COMPRESSION_CODE_DEFLATE_RAW;
}

// Is this FILE token-gated? Gated bytes are ciphertext and are never inflated
// here (the client inflates after decrypting).
function isGatedAction(actionString) {
    if (typeof actionString !== 'string' || actionString.length === 0) return false;
    const parts = extractFileSubcommand(actionString).split('|');
    if (parts.length <= GATE_TICKER_FIELD_INDEX) return false;
    if (String(parts[0]).toUpperCase() !== 'FILE') return false;
    if (String(parts[1]) !== '0') return false;
    return String(parts[GATE_TICKER_FIELD_INDEX]).length > 0;
}

/**
 * Inflate stored bytes, streamed and ratio-bounded. Never throws, never
 * returns partial output.
 *
 * @param {Buffer} stored
 * @param {object} [options]
 * @param {number} [options.maxRatio]
 * @returns {Promise<{bytes: Buffer, inflated: boolean, storedForm: boolean,
 *                    error: string|null, storedLength: number, originalLength: number}>}
 */
function inflateStoredBytes(stored, options = {}) {
    const maxRatio = (options.maxRatio === undefined) ? COMPRESSION_MAX_RATIO : options.maxRatio;

    const asStored = (input, error) => ({
        bytes: input,
        inflated: false,
        storedForm: true,
        error,
        storedLength: input ? input.length : 0,
        originalLength: input ? input.length : 0
    });

    if (!Buffer.isBuffer(stored)) {
        // Some drivers hand back a Uint8Array or a string; normalize what we
        // safely can and degrade on anything else.
        if (stored instanceof Uint8Array) stored = Buffer.from(stored);
        else if (typeof stored === 'string') stored = Buffer.from(stored, 'binary');
        else return Promise.resolve(asStored(Buffer.alloc(0), 'INVALID_INPUT'));
    }
    if (stored.length === 0) return Promise.resolve(asStored(stored, 'EMPTY_STREAM'));

    const ceiling = Math.max(1, Math.ceil(stored.length * maxRatio));

    return new Promise((resolve) => {
        const stream = zlib.createInflateRaw();
        let chunks = [];
        let total = 0;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            // Drop the partial output explicitly: on the abort path it is
            // exactly the memory the guard exists to defend.
            chunks = null;
            resolve(result);
        };

        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > ceiling) {
                stream.destroy();
                return finish(asStored(stored, 'RATIO_GUARD_TRIPPED'));
            }
            if (chunks) chunks.push(chunk);
        });

        stream.on('end', () => {
            if (settled) return;
            const bytes = Buffer.concat(chunks, total);
            finish({
                bytes,
                inflated: true,
                storedForm: false,
                error: null,
                storedLength: stored.length,
                originalLength: bytes.length
            });
        });

        // Truncated, corrupt, or simply-not-deflate bytes (a lying field).
        stream.on('error', () => finish(asStored(stored, 'INVALID_DEFLATE_STREAM')));

        stream.end(stored);
    });
}

/**
 * Resolve the bytes to serve for one FILE, applying every §5 rule in order.
 *
 * @param {Buffer} stored - the bytes exactly as stored on chain.
 * @param {string|null} actionString - the FULL stored action string, exactly as
 *   the decoder kept it. That is the TRANSACTION's string, so a batched FILE
 *   arrives as `BATCH|<v>|FILE|0|...` and is unwrapped by the gates.
 * @param {object} [options]
 * @param {boolean} [options.gated] - force the gated branch (the caller often
 *   already knows, because it read gated_files).
 * @returns {Promise<{bytes, inflated, storedForm, error, storedLength, originalLength}>}
 */
async function resolveServedBytes(stored, actionString, options = {}) {
    const passthrough = (input) => ({
        bytes: input,
        inflated: false,
        storedForm: false,
        error: null,
        storedLength: input ? input.length : 0,
        originalLength: input ? input.length : 0
    });

    // Gated ciphertext is served exactly as stored, always. Even when the
    // action declares COMPRESSION=1: there it means inflate-after-decrypt, and
    // the explorer holds no key.
    if (options.gated || isGatedAction(actionString)) return passthrough(stored);

    if (!isCompressedAction(actionString)) return passthrough(stored);

    return await inflateStoredBytes(stored, options);
}

module.exports = {
    resolveServedBytes,
    inflateStoredBytes,
    isCompressedAction,
    isGatedAction,
    extractFileSubcommand,
    COMPRESSION_CODE_DEFLATE_RAW,
    COMPRESSION_MAX_RATIO,
    COMPRESSION_FIELD_INDEX,
    GATE_TICKER_FIELD_INDEX
};
