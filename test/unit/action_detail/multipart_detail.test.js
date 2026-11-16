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

function manifest(completion_result) {
    return {
        kind: 'manifest',
        file_hash: 'ab'.repeat(32),
        total_parts: '3',
        parts_received: '2',
        total_bytes: '1200',
        completion_result
    };
}

function part(overrides) {
    return Object.assign({
        action_index: 91,
        source: 'bc1source',
        tx_hash: 'tx-part',
        block_index: 44,
        status: 'valid',
        file_hash: 'cd'.repeat(32),
        part_index: '2',
        manifest_action_index: 80
    }, overrides);
}

describe('multipart manifest summary', function() {
    it('normalizes counts and maps an unknown result to pending', function() {
        const input = manifest('waiting');
        const snapshot = structuredClone(input);
        assert.deepStrictEqual(buildMultipartSummary(input), {
            file_hash: input.file_hash,
            total_parts: 3,
            parts_received: 2,
            total_bytes: 1200,
            status: 'pending'
        });
        assert.deepStrictEqual(input, snapshot);
    });

    it('preserves complete and mismatch terminal results', function() {
        assert.strictEqual(buildMultipartSummary(manifest('complete')).status, 'complete');
        assert.strictEqual(buildMultipartSummary(manifest('mismatch')).status, 'mismatch');
    });

    it('maps null and undefined completion results to pending', function() {
        assert.strictEqual(buildMultipartSummary(manifest(null)).status, 'pending');
        assert.strictEqual(buildMultipartSummary(manifest(undefined)).status, 'pending');
    });

    it('returns null for part and invalid manifest records', function() {
        assert.strictEqual(buildMultipartSummary({ kind: 'part' }), null);
        assert.strictEqual(buildMultipartSummary({ kind: 'manifest-invalid' }), null);
    });
});

describe('multipart file part detail', function() {
    it('builds the FILE format 2 detail and coerces a string part index', function() {
        const input = part();
        const snapshot = structuredClone(input);
        const detail = buildFilePartDetail(input);
        assert.deepStrictEqual(detail, {
            action: 'FILE', action_format: 2, action_index: 91,
            source: 'bc1source', tx_hash: 'tx-part', block_index: 44, status: 'valid',
            file_part: { file_hash: input.file_hash, part_index: 2, manifest_action_index: 80 }
        });
        assert.deepStrictEqual(input, snapshot);
    });

    it('keeps a manifest action index of zero', function() {
        assert.strictEqual(buildFilePartDetail(part({ manifest_action_index: 0 })).file_part.manifest_action_index, 0);
    });

    it('uses null when the manifest action index is absent or non-numeric', function() {
        for(const value of [null, undefined, 'not-a-number', '  ']) {
            const detail = buildFilePartDetail(part({ manifest_action_index: value }));
            assert.strictEqual(detail.file_part.manifest_action_index, null);
        }
    });

    it('returns null for a null row', function() {
        assert.strictEqual(buildFilePartDetail(null), null);
    });
});
