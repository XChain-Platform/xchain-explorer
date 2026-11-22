/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const {
    filePartBlockCountSql,
    mergeFilePartCounts,
} = require('../../../../../src/db/readers/entities/file_part_block_counts.js');

const expectedSql = (count) => `SELECT
                        'files' as action,
                        b1.block_index,
                        count(*) as count
                    FROM
                        file_parts m
                        INNER JOIN actions      a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks       b1 ON (b1.block_index=t1.block_index)
                    WHERE
                        b1.block_index IN (${Array(count).fill('?').join(',')})
                    GROUP BY b1.block_index`;

async function executeCountRead(blockIndexes){
    const doQuery = sinon.stub().resolves([]);
    const [query, args] = filePartBlockCountSql(blockIndexes);
    await doQuery({}, query, args);
    return { doQuery, query, args };
}

describe('file part block count SQL', function () {
    it('runs one parameterized statement for two block indexes', async function () {
        const indexes = [17, 403];
        const { doQuery, query, args } = await executeCountRead(indexes);
        expect(doQuery.callCount).to.equal(1);
        expect(query).to.equal(expectedSql(2));
        expect(args).to.deep.equal(indexes);
        expect(query).not.to.include('17');
        expect(query).not.to.include('403');
    });

    it('keeps the statement shape and argument order for 26 indexes', async function () {
        const indexes = Array.from({ length: 26 }, (_, i) => 9000 + i);
        const { doQuery, query, args } = await executeCountRead(indexes);
        expect(doQuery.callCount).to.equal(1);
        expect(query).to.equal(expectedSql(26));
        expect(args).to.deep.equal(indexes);
        for(const index of indexes) expect(query).not.to.include(String(index));
    });
});

describe('file part block count merge', function () {
    it('adds part-only and existing file counts while skipping absent blocks', function () {
        const blockMap = {
            10: { actions: {} },
            11: { actions: { files: 3 } },
            12: { actions: { files: 'not-a-count' } },
        };
        mergeFilePartCounts(blockMap, [
            { block_index: 10, count: '4' },
            { block_index: 11, count: '2' },
            { block_index: 12, count: '1' },
            { block_index: 99, count: '8' },
        ]);
        expect(blockMap).to.deep.equal({
            10: { actions: { files: 4 } },
            11: { actions: { files: 5 } },
            12: { actions: { files: 1 } },
        });
    });

    it('changes nothing for an empty row list', function () {
        const blockMap = { 10: { actions: { files: 3 } } };
        mergeFilePartCounts(blockMap, []);
        expect(blockMap).to.deep.equal({ 10: { actions: { files: 3 } } });
    });
});
