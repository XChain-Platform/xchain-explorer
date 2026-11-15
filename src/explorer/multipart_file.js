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
 ********************************************************************/

'use strict';

const crypto = require('crypto');

const MULTIPART_FILE_MAX_BYTES = 12000000;
const COMPRESSION_MAX_RATIO = 150;

class MultipartFileError extends Error {
    constructor(code, status, message) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function refusalForMultipart(record) {
    if(record.kind === 'part')
        return new MultipartFileError('FILE_PART', 404, 'File parts cannot be served directly');
    if(record.kind === 'manifest-invalid')
        return new MultipartFileError('NOT_FOUND', 404, 'Not found');
    if(record.kind !== 'manifest') return null;
    if(String(record.completion_result) === 'mismatch')
        return new MultipartFileError('FILE_ASSEMBLY_MISMATCH', 422, 'File assembly does not match the manifest');
    if(String(record.completion_result) !== 'complete') {
        const error = new MultipartFileError('FILE_INCOMPLETE', 409, 'File is incomplete');
        error.parts_received = Number(record.parts_received) || 0;
        error.total_parts = Number(record.total_parts) || 0;
        return error;
    }
    return null;
}

function assembleMultipartFile(record) {
    const totalParts = Number(record.total_parts);
    if(!Array.isArray(record.parts) || record.parts.length !== totalParts)
        throw new MultipartFileError('SERVER_ERROR', 500, 'Multipart FILE parts are unavailable');
    const chunks = [];
    for(let position = 0; position < totalParts; position++) {
        const part = record.parts[position];
        let bytes = null;
        if(part && Buffer.isBuffer(part.raw_data)) bytes = part.raw_data;
        else if(part && part.raw_data instanceof Uint8Array) bytes = Buffer.from(part.raw_data);
        if(!part || part.position !== position || bytes === null)
            throw new MultipartFileError('SERVER_ERROR', 500, 'Multipart FILE part is unavailable');
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if(bytes.length !== Number(part.byte_length) || digest !== String(part.part_digest).toLowerCase())
            throw new MultipartFileError('FILE_PART_CORRUPT', 500, 'Multipart FILE part is corrupt');
        chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if(bytes.length !== Number(record.total_bytes))
        throw new MultipartFileError('FILE_PART_CORRUPT', 500, 'Multipart FILE part lengths are corrupt');
    if(typeof record.data !== 'string')
        throw new MultipartFileError('SERVER_ERROR', 500, 'Multipart FILE manifest data is unavailable');
    return bytes;
}

function maxInflatedBytes(storedLength) {
    return Math.min(COMPRESSION_MAX_RATIO * Number(storedLength), MULTIPART_FILE_MAX_BYTES);
}

function recordFromRows(rows, util) {
    const first = rows && rows[0] ? rows[0] : null;
    if(!first || util.isNull(first.manifest_action_index))
        return { kind: first && Number(first.part_exists) === 1 ? 'part' : 'none' };
    if(String(first.manifest_status) !== 'valid') return { kind: 'manifest-invalid' };
    const parts = rows.filter(row => !util.isNull(row.position)).map(row => ({
        position: Number(row.position),
        action_index: Number(row.part_action_index),
        tx_hash: row.part_tx_hash,
        byte_length: Number(row.byte_length),
        part_digest: String(row.part_digest)
    }));
    return {
        kind: 'manifest',
        action_index: Number(first.manifest_action_index),
        file_hash: String(first.file_hash),
        total_parts: Number(first.total_parts),
        total_bytes: Number(first.total_bytes),
        parts_received: parts.length,
        completion_result: first.completion_result,
        name: first.name,
        type: first.type,
        gated: Number(first.gated) === 1,
        manifest_tx_hash: first.manifest_tx_hash,
        data: null,
        parts
    };
}

function decoderHashes(record, util) {
    const hashes = [record.manifest_tx_hash, ...record.parts.map(part => part.tx_hash)];
    if(hashes.some(hash => util.isNull(hash)))
        throw new Error('Multipart FILE transaction hash is unavailable');
    return [...new Set(hashes.map(String))];
}

function hydrateRecord(record, rows) {
    const byHash = new Map((rows || []).map(row => [String(row.hash), row]));
    const manifestRow = byHash.get(String(record.manifest_tx_hash));
    record.data = manifestRow ? manifestRow.data : null;
    record.parts = record.parts.map(part => {
        const decoded = byHash.get(String(part.tx_hash));
        return { ...part, raw_data: decoded ? decoded.raw_data : null };
    });
    return record;
}

module.exports = {
    MultipartFileError,
    refusalForMultipart,
    assembleMultipartFile,
    maxInflatedBytes,
    recordFromRows,
    decoderHashes,
    hydrateRecord,
    MULTIPART_FILE_MAX_BYTES,
    COMPRESSION_MAX_RATIO
};
