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
 **********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SOURCE = path.resolve(__dirname, '../../../src/content/js/xchain/action_detail.js');

function extractFunction(source, name){
    const start = source.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, 'function not found: ' + name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for(let i = open; i < source.length; i++){
        if(source[i] === '{') depth++;
        if(source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('unterminated function: ' + name);
}

const source = fs.readFileSync(SOURCE, 'utf8');
const attestBatchLabel = new Function(
    extractFunction(source, 'attestBatchLabel') + '; return attestBatchLabel;'
)();

function head(overrides){
    return Object.assign({
        version: 5,
        batch_window_start: Date.UTC(2026, 9, 2, 10, 0) / 1000,
        batch_window_end: Date.UTC(2026, 9, 2, 11, 0) / 1000,
        batch_row_count: 0
    }, overrides);
}

function assertResponseLabels(){
    assert.strictEqual(
        attestBatchLabel(head({ batch_row_count: 0 })),
        'Batch 2026-10-02 10:00 to 2026-10-02 11:00 UTC (0 responses)'
    );
    assert.strictEqual(
        attestBatchLabel(head({ batch_row_count: 1 })),
        'Batch 2026-10-02 10:00 to 2026-10-02 11:00 UTC (1 response)'
    );
    assert.strictEqual(
        attestBatchLabel(head({ batch_row_count: 37 })),
        'Batch 2026-10-02 10:00 to 2026-10-02 11:00 UTC (37 responses)'
    );
}

function assertMidnightWindowLabel(){
    assert.strictEqual(attestBatchLabel(head({
        batch_window_start: Date.UTC(2026, 9, 2, 23, 30) / 1000,
        batch_window_end: Date.UTC(2026, 9, 3, 0, 30) / 1000,
        batch_row_count: 2
    })), 'Batch 2026-10-02 23:30 to 2026-10-03 00:30 UTC (2 responses)');
}

function assertContinuationLabels(){
    assert.strictEqual(attestBatchLabel({
        version: 6,
        batch_chunk_index: 0,
        batch_total_chunks: 4
    }), 'Batch continuation (chunk 1 of 4)');
    assert.strictEqual(attestBatchLabel({
        version: '6',
        batch_chunk_index: '2',
        batch_total_chunks: '04'
    }), 'Batch continuation (chunk 3 of 4)');
}

function assertLegacyRowsReturnNull(){
    assert.strictEqual(attestBatchLabel({ version: 0 }), null);
    assert.strictEqual(attestBatchLabel({ version: 1 }), null);
}

function assertInvalidRowsReturnNull(){
    assert.strictEqual(attestBatchLabel({ version: Symbol('5') }), null);
    for(const field of ['batch_window_start', 'batch_window_end', 'batch_row_count']){
        const missing = head();
        delete missing[field];
        assert.strictEqual(attestBatchLabel(missing), null, field + ' missing');
        assert.strictEqual(attestBatchLabel(head({ [field]: 'not-a-number' })), null, field + ' non-numeric');
    }
    assert.strictEqual(attestBatchLabel(head({ batch_row_count: Symbol('1') })), null);

    for(const field of ['batch_chunk_index', 'batch_total_chunks']){
        const row = { version: 6, batch_chunk_index: 0, batch_total_chunks: 2 };
        delete row[field];
        assert.strictEqual(attestBatchLabel(row), null, field + ' missing');
        assert.strictEqual(attestBatchLabel({
            version: 6,
            batch_chunk_index: field === 'batch_chunk_index' ? '<b>0</b>' : 0,
            batch_total_chunks: field === 'batch_total_chunks' ? '<b>2</b>' : 2
        }), null, field + ' non-numeric');
    }
}

function assertNumericStringsAreNormalized(){
    assert.strictEqual(attestBatchLabel(head({
        version: '5',
        batch_window_start: String(Date.UTC(2026, 9, 2, 10, 0) / 1000),
        batch_window_end: String(Date.UTC(2026, 9, 2, 11, 0) / 1000),
        batch_row_count: '01'
    })), 'Batch 2026-10-02 10:00 to 2026-10-02 11:00 UTC (1 response)');
}

describe('attestBatchLabel', function(){
    it('labels zero, one, and many responses with the correct plural', assertResponseLabels);
    it('keeps both UTC dates when the window crosses midnight', assertMidnightWindowLabel);
    it('labels continuation chunks from their zero-based slot', assertContinuationLabels);
    it('returns null for v0 and v1 attestation rows', assertLegacyRowsReturnNull);
    it('returns null when a required field is missing or non-numeric', assertInvalidRowsReturnNull);
    it('normalizes numeric strings before building the label', assertNumericStringsAreNormalized);
});
