/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const MULTIPART_FILE_MAX_PARTS = 32;
const MULTIPART_FILE_MAX_BYTES = 12000000;

function numericOrNull(value) {
    if(value === null || value === undefined) return null;
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    if(typeof value === 'string' && value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function manifestCounts(record) {
    const totalParts = numericOrNull(record.total_parts);
    const partsReceived = numericOrNull(record.parts_received);
    const totalBytes = numericOrNull(record.total_bytes);
    const valid = Number.isInteger(totalParts) && totalParts >= 2 && totalParts <= MULTIPART_FILE_MAX_PARTS &&
        Number.isInteger(partsReceived) && partsReceived >= 0 && partsReceived <= totalParts &&
        Number.isInteger(totalBytes) && totalBytes >= 1 && totalBytes <= MULTIPART_FILE_MAX_BYTES;
    return valid ? { totalParts, partsReceived, totalBytes } : null;
}

function buildMultipartSummary(record) {
    if(!record || record.kind !== 'manifest') return null;
    const counts = manifestCounts(record);
    if(!/^[0-9a-f]{64}$/.test(record.file_hash) || counts === null) return null;
    const result = record.completion_result;
    const status = result === 'complete' || result === 'mismatch' ? result : 'pending';
    return {
        file_hash: record.file_hash,
        total_parts: counts.totalParts,
        parts_received: counts.partsReceived,
        total_bytes: counts.totalBytes,
        status
    };
}

function buildFilePartDetail(row) {
    if(row === null) return null;
    return {
        action: 'FILE',
        action_format: 2,
        action_index: row.action_index,
        source: row.source,
        tx_hash: row.tx_hash,
        block_index: row.block_index,
        status: row.status,
        file_part: {
            file_hash: row.file_hash,
            part_index: Number(row.part_index),
            manifest_action_index: numericOrNull(row.manifest_action_index)
        }
    };
}

module.exports = { buildMultipartSummary, buildFilePartDetail };
