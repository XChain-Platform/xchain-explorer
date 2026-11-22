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

function filePartBlockCountSql(blockIndexes){
    const placeholders = blockIndexes.map(() => '?').join(',');
    const query = `SELECT
                        'files' as action,
                        b1.block_index,
                        count(*) as count
                    FROM
                        file_parts m
                        INNER JOIN actions      a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks       b1 ON (b1.block_index=t1.block_index)
                    WHERE
                        b1.block_index IN (` + placeholders + `)
                    GROUP BY b1.block_index`;
    return [query, blockIndexes.slice()];
}

function mergeFilePartCounts(blockMap, rows){
    for(const row of rows){
        const block = blockMap[row.block_index];
        if(!block) continue;
        const existing = Number(block.actions.files);
        const base = Number.isFinite(existing) ? existing : 0;
        block.actions.files = base + Number(row.count);
    }
}

module.exports = { filePartBlockCountSql, mergeFilePartCounts };
