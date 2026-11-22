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

const assert = require('assert');
const {
    buildMultipartSummary,
    buildFilePartDetail
} = require('../../../src/action-detail/multipart_detail');

function manifest(overrides = {}) {
    return Object.assign({
        kind: 'manifest',
        file_hash: 'ab'.repeat(32),
        total_parts: 65535,
        parts_received: 65535,
        total_bytes: 5000000000n,
        completion_result: 'complete'
    }, overrides);
}

describe('multipart manifest expanded limits', function() {
    it('returns JSON integers for a bigint byte count and the maximum part count', function() {
        const summary = buildMultipartSummary(manifest());

        assert.deepStrictEqual(summary, {
            file_hash: 'ab'.repeat(32),
            total_parts: 65535,
            parts_received: 65535,
            total_bytes: 5000000000,
            status: 'complete'
        });
        assert.strictEqual(JSON.stringify(summary).includes('5000000000'), true);
    });

    it('rejects a manifest above either expanded limit', function() {
        assert.strictEqual(buildMultipartSummary(manifest({ total_parts: 65536 })), null);
        assert.strictEqual(buildMultipartSummary(manifest({ total_bytes: 262140000001n })), null);
    });

    it('does not convert a bigint above the safe integer range', function() {
        const detail = buildFilePartDetail({ manifest_action_index: BigInt(Number.MAX_SAFE_INTEGER) + 1n });

        assert.strictEqual(detail.file_part.manifest_action_index, null);
    });
});
