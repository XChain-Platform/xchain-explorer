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
 **********************************************************************
 *
 * XChain Explorer - the block reads
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). One block by height or hash, and the paged block
 * list with the per-block action counts the list page renders.
 *
 * The strict height shape lives here rather than in the shared module
 * because these two are the only readers that take a height off a URL and
 * must reject a coerced one before it reaches SQL.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const { DbInputError } = require('../../shared.js');

// A block height is a non-negative integer and nothing else. parseInt/Number
// cannot make this call: parseInt('9junk') is 9 and Number('') is 0, both of
// which reproduce the coercion bug in JS instead of catching it. Same strict
// shape as the /api/action and /api/checkpoint route guards in XChainExplorer.js.
const BLOCK_INDEX_RE = /^[0-9]+$/;

// The per-action-table count query for one page of blocks, as [query, args]. One
// UNION ALL over every action table rather than a query per table, so a page costs
// one round trip however many action families the protocol has. A module function
// rather than a method: Database.prototype carries the family's public readers and
// nothing else, so a cut made for length adds no name to it.
function blockActionCountSql(db, blockIndexes){
    let query = '';
    let args  = [];
    let placeholders = blockIndexes.map(() => '?').join(',');
    for(let table of db.actionTables){
        if(query != '')
            query += ' UNION ALL ';
        // full_node_verifications writes one row per validator pubkey sharing one
        // action_index (NODEPROOF fan-out), so COUNT(*) over-counts by validator
        // set size. Use COUNT(DISTINCT action_index) for this table only.
        const countExpr = (table === 'full_node_verifications')
            ? 'count(DISTINCT m.action_index)'
            : 'count(*)';
        query += `SELECT
                            '` + table + `' as action,
                            b1.block_index,
                            ` + countExpr + ` as count
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            b1.block_index IN (` + placeholders + `)
                        GROUP BY b1.block_index`;
        args.push(...blockIndexes);
    }
    return [query, args];
}

// Turns the rows of a block-list page into the shape the feed serves, with each
// block's per-action-type counts folded in. A block with no actions keeps the empty
// `actions` object it was seeded with, so a quiet block still renders as a row.
async function attachBlockActionCounts(db, config, rows){
    let blockIndexes = rows.map(r => r.block_index);
    let blockMap = {};
    for(let row of rows){
        blockMap[row.block_index] = {
            block_index: row.block_index,
            timestamp: row.block_time,
            actions: {}
        };
    }
    let [query2, blockArgs] = blockActionCountSql(db, blockIndexes);
    let results2 = await db.doQuery(config, query2, blockArgs);
    if(results2 && results2.length){
        for(let row of results2){
            let bIdx = Number(row.block_index);
            if(blockMap[bIdx])
                blockMap[bIdx].actions[row.action] = row.count;
        }
    }
    return rows.map(r => blockMap[r.block_index]);
}

class EntityBlockReaders {
    async getBlock(config){
        let data = null;
        let sql   = config.data.sql;
        // The search segment is bound against the BIGINT blocks.block_index, and
        // MariaDB coerces a non-numeric string to 0 rather than rejecting it, so
        // an unguarded /api/block/zzz would answer 200 with BLOCK 0's real
        // record - a wrong answer dressed as a right one, which nothing
        // downstream can detect. Refuse the id before it reaches the query.
        if(!BLOCK_INDEX_RE.test(String(config.data.search ?? '')))
            throw new DbInputError('Invalid block_index', 'INVALID_BLOCK_INDEX');
        let args  = [config.data.search];
        let query = `SELECT
                        b1.block_index,
                        b1.block_time as timestamp,
                        t1.hash as ledger_hash,
                        t2.hash as actions_hash,
                        t3.hash as contract_hash,
                        t4.hash as state_hash
                    FROM
                        blocks b1
                        LEFT  JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=b1.actions_hash_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                        LEFT  JOIN index_transactions t4 ON (t4.id=b1.state_hash_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = results[0];
        return [data];
    }

    async getBlocks(config){
        let sql     = config.data.sql;
        let offset  = config.data.offset;
        let data    = [];
        let total   = 0;
        let query   = '';
        let results = null;
        query = `SELECT
                    count(*) as total
                FROM
                    blocks b1
                WHERE ` + sql.where.data;
        results = await this.doQuery(config, query);
        if(results && results.length)
            total = results[0].total;
        // BIND THE PAGING PLACEHOLDER. getBlocks builds and runs its own queries rather than
        // returning [query, args] to the shared path, and that shared path is where every
        // other list method gets its offset args threaded in. Without them the `?` in
        // `AND b1.block_index < ?` reached MariaDB as literal text and the whole feed
        // answered 500 on a syntax error, on every coin and every network - page 1 included,
        // because the first page carries an offset clause too. getBlocks takes no
        // data-WHERE placeholder of its own (getQueryWhereSql excludes it from the type
        // branch and anchors on `b1.block_index IS NOT NULL`), so the offset args are the
        // complete set; the count query above needs none for the same reason.
        let offsetArgs = (sql.where.offsetArgs && sql.where.offsetArgs.length) ? sql.where.offsetArgs : undefined;
        query = `SELECT
                    block_index,
                    block_time
                FROM
                    blocks b1
                WHERE
                    ` + sql.where.data + sql.where.offset + `
                ORDER BY block_index ` + sql.order + `
                LIMIT ` + sql.limit;
        results = await this.doQuery(config, query, offsetArgs);
        if(results && results.length)
            data = await attachBlockActionCounts(this, config, results);
        return [data, null, total];
    }
}

module.exports = EntityBlockReaders.prototype;
