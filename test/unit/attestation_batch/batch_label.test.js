/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ATTEST_DETAIL } = require('../../../src/db/action_detail/consensus_sql.js');
const { ATTEST } = require('../../../src/action-detail/consensus.js');

const source = fs.readFileSync(path.resolve(__dirname,
    '../../../src/content/js/xchain/action_detail.js'), 'utf8');
const context = {
    XC: { coin: 'RDOGE' },
    escapeHtml(value){
        return String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }
};
vm.createContext(context);
vm.runInContext(source, context);

function head(count){
    return {
        action_format: 5,
        batch_window_start: Date.UTC(2026, 9, 2, 10, 0) / 1000,
        batch_window_end: Date.UTC(2026, 9, 2, 11, 0) / 1000,
        batch_row_count: count
    };
}

describe('ATTEST batch summaries', function(){
    for(const [count, noun] of [[0, '0 responses'], [1, '1 response'], [8, '8 responses']]){
        it('labels a v5 batch carrying ' + count + ' responses', function(){
            assert.strictEqual(context.getActionDetails('ATTEST', head(count)),
                'Batch 2026-10-02 10:00 to 2026-10-02 11:00 UTC (' + noun + ')');
        });
    }

    it('labels a v6 continuation from the action detail aliases', function(){
        assert.strictEqual(context.getActionDetails('ATTEST', {
            action_format: 6,
            chunk_index: 2,
            total_chunks: 5
        }), 'Batch continuation (chunk 3 of 5)');
    });

    it('leaves a v0 row on the existing ATTEST fallback', function(){
        assert.strictEqual(context.getActionDetails('ATTEST', { action_format: 0 }), 'Attest');
    });
});

describe('ATTEST action detail batch fields', function(){
    it('selects the batch label, chunk and archive-link fields', function(){
        for(const field of [
            'batch_action_index', 'batch_window_start', 'batch_window_end', 'batch_row_count',
            'batch_total_chunks', 'batch_chunk_index'
        ]) assert.match(ATTEST_DETAIL, new RegExp('m\\.' + field));
    });

    it('aliases v6 chunk fields into the compact summary projection names', async function(){
        const data = {
            version: 6,
            validator_signatures: null,
            batch_chunk_index: 2,
            batch_total_chunks: 5
        };
        await ATTEST.afterMain({
            db: { util: { isNull: value => value === null || value === undefined || value === '' } },
            config: {}, action_index: 50
        }, data);
        assert.strictEqual(data.chunk_index, 2);
        assert.strictEqual(data.total_chunks, 5);
    });
});
