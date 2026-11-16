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

function buildMultipartSummary(record) {
    if(!record || record.kind !== 'manifest') return null;
    const result = record.completion_result;
    const status = result === 'complete' || result === 'mismatch' ? result : 'pending';
    return {
        file_hash: record.file_hash,
        total_parts: Number(record.total_parts),
        parts_received: Number(record.parts_received),
        total_bytes: Number(record.total_bytes),
        status
    };
}

function numericOrNull(value) {
    if(value === null || value === undefined) return null;
    if(typeof value === 'string' && value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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
