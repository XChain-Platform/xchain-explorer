'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto');
const sinon = require('sinon');

function digest(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function manifestData({ gated = false, compressed = false } = {}) {
    return ['FILE', '1', 'a'.repeat(64), '2', '4', 'file.bin', 'application/octet-stream',
        '', '', gated ? 'TOKEN' : '', gated ? '1' : '', gated ? 'b'.repeat(64) : '', '',
        compressed ? '1' : '0'].join('|');
}

function completeRecord(chunks, options = {}) {
    return {
        kind: 'manifest',
        action_index: 50,
        file_hash: 'a'.repeat(64),
        total_parts: chunks.length,
        total_bytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0),
        parts_received: chunks.length,
        completion_result: 'complete',
        name: options.name || 'file.bin',
        type: options.type || 'application/octet-stream',
        gated: Boolean(options.gated),
        data: manifestData(options),
        parts: chunks.map((bytes, position) => ({
            position,
            action_index: 60 + position,
            tx_hash: 'part-' + position,
            byte_length: bytes.length,
            part_digest: digest(bytes),
            raw_data: bytes
        }))
    };
}

function reader(partCount, decoderDb = 'Decoder_RBTC') {
    const chunks = Array.from({ length: partCount }, (_, position) => Buffer.from('part-' + position));
    const manifestHash = 'manifest-hash';
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const indexRows = chunks.map((bytes, position) => ({
        manifest_action_index: 50,
        manifest_status: 'valid',
        part_exists: 0,
        file_hash: 'a'.repeat(64),
        total_parts: partCount,
        total_bytes: totalBytes,
        name: 'file.bin',
        type: 'application/octet-stream',
        gated: 0,
        completion_result: 'complete',
        manifest_tx_hash: manifestHash,
        position,
        part_action_index: 60 + position,
        part_tx_hash: 'part-hash-' + position,
        byte_length: bytes.length,
        part_digest: digest(bytes)
    }));
    const decoderRows = [
        { hash: manifestHash, raw_data: null, data: manifestData() },
        ...chunks.map((bytes, position) => ({ hash: 'part-hash-' + position, raw_data: bytes, data: 'FILE|2' }))
    ];
    return {
        util: { isNull: value => value === null || value === undefined },
        decoderDb: { RBTC: decoderDb },
        doQuery: sinon.stub().resolves(indexRows),
        doDecoderQuery: sinon.stub().resolves(decoderRows)
    };
}

module.exports = { completeRecord, manifestData, reader };
