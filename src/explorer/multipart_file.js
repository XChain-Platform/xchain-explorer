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

const MULTIPART_FILE_MAX_BYTES = 262140000000;
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
        parts_received: Number(util.isNull(first.parts_received) ? parts.length : first.parts_received) || 0,
        completion_result: first.completion_result,
        name: first.name,
        type: first.type,
        gated: Number(first.gated) === 1,
        manifest_tx_hash: first.manifest_tx_hash,
        data: null,
        parts
    };
}

module.exports = {
    MultipartFileError,
    refusalForMultipart,
    maxInflatedBytes,
    recordFromRows,
    MULTIPART_FILE_MAX_BYTES,
    COMPRESSION_MAX_RATIO
};
