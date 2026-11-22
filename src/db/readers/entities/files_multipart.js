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

const sql = require('../../action_detail/misc_sql.js');
const { SUPPLEMENTAL_ACTION_TABLES } = require('../../method_tables.js');
const { setTablesAbsent, isMissingTableError } = require('../../schema_probe.js');

const fileParts = SUPPLEMENTAL_ACTION_TABLES.find(row => row.table === 'file_parts');

async function readFilePartDetail(db, config, actionIndex){
    const rows = await db.doQuery(config, sql.FILE_PART_QUERY, [actionIndex]);
    return rows && rows.length ? rows[0] : null;
}

function filePartBlockCountSql(blockIndexes){
    const placeholders = blockIndexes.map(() => '?').join(',');
    const query = `SELECT
                        b1.block_index,
                        count(*) as count
                    FROM
                        ${fileParts.table} m
                        INNER JOIN actions a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks b1 ON (b1.block_index=t1.block_index)
                    WHERE
                        b1.block_index IN (${placeholders})
                    GROUP BY b1.block_index`;
    return [query, blockIndexes.slice()];
}

function mergeFilePartCounts(blocks, rows){
    const byIndex = new Map(blocks.map(block => [Number(block.block_index), block]));
    for(const row of rows || []){
        const block = byIndex.get(Number(row.block_index));
        if(!block) continue;
        const current = Number(block.actions[fileParts.action]);
        block.actions[fileParts.action] = (Number.isFinite(current) ? current : 0) + Number(row.count);
    }
    return blocks;
}

async function attachFilePartBlockCounts(db, config, blocks){
    if(!Array.isArray(blocks) || blocks.length === 0) return blocks;
    const indexes = [...new Set(blocks.map(block => Number(block.block_index)))];
    // An indexer that has not taken the multipart migration has no file_parts table;
    // its blocks page still answers, with no part counts, rather than a 500.
    const [query, args] = filePartBlockCountSql(indexes);
    let rows;
    try {
        rows = await db.doQuery(config, query, args);
    } catch(e) {
        if(!isMissingTableError(e)) throw e;
        setTablesAbsent(db, config, ['file_parts']);
        return blocks;
    }
    return mergeFilePartCounts(blocks, rows);
}

class MultipartFileReaders {
    async getFilePartDetail(config, actionIndex) {
        const query = `SELECT fp.action_index, source.address AS source,
                              tx_hash.hash AS tx_hash, fp.block_index,
                              part_status.status AS status, fp.file_hash,
                              fp.part_index,
                              (SELECT MIN(fm.action_index)
                               FROM file_manifests fm
                               INNER JOIN index_statuses manifest_status
                                   ON (manifest_status.id=fm.status_id)
                               WHERE fm.source_id=fp.source_id
                                 AND fm.file_hash=fp.file_hash
                                 AND manifest_status.status='valid') AS manifest_action_index
                       FROM file_parts fp
                       INNER JOIN index_addresses source ON (source.id=fp.source_id)
                       INNER JOIN index_statuses part_status ON (part_status.id=fp.status_id)
                       INNER JOIN actions part_action ON (part_action.action_index=fp.action_index)
                       INNER JOIN transactions part_tx ON (part_tx.tx_index=part_action.tx_index)
                       INNER JOIN index_transactions tx_hash ON (tx_hash.id=part_tx.tx_hash_id)
                       WHERE fp.action_index=?
                       LIMIT 1`;
        // Same net as the block counts: no multipart tables means no part to answer.
        let rows;
        try {
            rows = await this.doQuery(config, query, [Number(actionIndex)]);
        } catch(e) {
            if(!isMissingTableError(e)) throw e;
            setTablesAbsent(this, config, ['file_parts', 'file_manifests']);
            return null;
        }
        return rows && rows.length ? rows[0] : null;
    }
}

// The composer copies every own property of this prototype onto Database.prototype,
// so the wiring helpers ride as non-enumerable properties: callers keep reading them
// here, and no for-in over a Database yields their names.
for(const [name, value] of Object.entries({ readFilePartDetail, filePartBlockCountSql, mergeFilePartCounts, attachFilePartBlockCounts }))
    Object.defineProperty(MultipartFileReaders.prototype, name, { value, writable: true, configurable: true, enumerable: false });

module.exports = MultipartFileReaders.prototype;
