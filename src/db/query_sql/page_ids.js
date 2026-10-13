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
 * XChain Explorer - one list page picked by id, then decorated
 *
 * One part of src/db/query_sql.js: an action list whose page query carries a
 * dozen display joins can let MariaDB join and sort every matching row before
 * the LIMIT applies. A reader that opts in hands runListQuery a page plan: an
 * ids leg that picks the page's action_index values through only the joins
 * that decide membership, and a rows leg that runs the reader's own SELECT for
 * just those ids. The ids leg is the reader's COUNT with its count-neutral
 * joins pruned (count_joins.js), so it selects exactly the rows the single
 * statement would, in the same cursor order.
 *
 * The page-boundary statements getQueryOffsets runs (offset_boundaries.js) go
 * through the same leg builder, so a boundary reads the same pruned tables as
 * the ids leg and the count, and a block lane drives from actions there too.
 *
 * Plain functions: the builders are database-free, and the runner takes the
 * Database as `db` for doQuery.
 *
 ********************************************************************/

'use strict';

const { parseCountSql, pruneCountJoins } = require('./count_joins.js');

const BLOCK_LANE_RE = /(?:^|[^\w.])a1\.block_index=\?/;

// SELECT [DISTINCT] [STRAIGHT_JOIN] <alias>.action_index as offset_index FROM ...
// ORDER BY <alias>.action_index <order> LIMIT <n>, the shape of every boundary
// statement paged on action_index.
const BOUNDARY_RE = new RegExp('^\\s*SELECT\\s+(DISTINCT\\s+)?(STRAIGHT_JOIN\\s+)?(DISTINCT\\s+)?'
    + '(\\w+)\\.action_index\\s+as\\s+offset_index\\s+FROM\\s+([\\s\\S]+?)\\s+'
    + 'ORDER BY\\s+(\\w+)\\.action_index\\s+(ASC|DESC)\\s+LIMIT\\s+(\\d+)\\s*$', 'i');

// actions has no primary key, so InnoDB clusters it on the unique action_index and
// its block_index index runs in action_index order: driving the block lane from it
// reads one page and stops, for a dense block and a sparse one alike.
function drivesFromActions(parsed){
    const first = parsed.joins[0];
    return !!first && first.kind === 'INNER' && first.table === 'actions' && first.alias === 'a1'
        && first.on.replace(/\s+/g, '') === 'a1.action_index=' + parsed.alias + '.action_index'
        && BLOCK_LANE_RE.test(parsed.where);
}

// A cursor-only leg over a COUNT's pruned FROM and WHERE: <alias>.action_index named
// `as`, in `order`, up to `limit`. opts.distinct and opts.straight carry those select
// modifiers. Null for a COUNT the parser does not read.
function cursorLegSql(countSql, as, order, limit, opts = {}){
    const parsed = parseCountSql(pruneCountJoins(countSql));
    if(!parsed)
        return null;
    const distinct = opts.distinct ? 'DISTINCT ' : '';
    const tail = [parsed.where, 'ORDER BY {c} ' + order, 'LIMIT ' + limit];
    if(drivesFromActions(parsed)){
        const head = ['SELECT ' + distinct + 'STRAIGHT_JOIN a1.action_index as ' + as + ' FROM actions a1',
            'INNER JOIN ' + parsed.table + ' ' + parsed.alias + ' ON (' + parsed.alias + '.action_index=a1.action_index)'];
        return head.concat(parsed.joins.slice(1).map(j => j.text), tail).join(' ').replace('{c}', 'a1.action_index');
    }
    const cursor = parsed.alias + '.action_index';
    const select = 'SELECT ' + distinct + (opts.straight ? 'STRAIGHT_JOIN ' : '') + cursor + ' as ' + as;
    return [select + ' FROM ' + parsed.table + ' ' + parsed.alias]
        .concat(parsed.joins.map(j => j.text), tail).join(' ').replace('{c}', cursor);
}

// The ids leg of a list paged on <alias>.action_index: the pruned COUNT's FROM and
// WHERE (paging predicate included) selecting only the cursor, or null for a COUNT
// the parser does not read, which keeps the single statement.
function pageIdsSql(countSql, order, limit){
    return cursorLegSql(countSql, 'action_index', order, limit);
}

// A page-boundary statement (offset_boundaries.js) paged on its base table's
// action_index, rebuilt the way the ids leg is: count-neutral joins pruned, and a
// block lane driven from actions. Any other statement is returned unchanged,
// as is one with nothing to prune and no block lane to drive.
function prunedBoundarySql(sql){
    const m = BOUNDARY_RE.exec(sql);
    if(!m || m[4] !== m[6])
        return sql;
    const countSql = 'SELECT count(*) as total FROM ' + m[5];
    const parsed   = parseCountSql(countSql);
    if(!parsed || parsed.alias !== m[4] || (pruneCountJoins(countSql) === countSql && !drivesFromActions(parsed)))
        return sql;
    return cursorLegSql(countSql, 'offset_index', m[7].toUpperCase(), m[8],
        { distinct: !!(m[1] || m[3]), straight: !!m[2] });
}

// The page plan a reader returns after [query, args, count]: the ids leg, and
// rows(size), its SELECT (rowsHead ends at WHERE) over `size` bound ids in order.
// The runner appends any API OFFSET to the ids leg.
function idsFirstPage(countSql, rowsHead, alias, order, limit){
    const ids = pageIdsSql(countSql, order, limit);
    if(!ids)
        return null;
    const rows = (size) => rowsHead + alias + '.action_index IN (' + new Array(size).fill('?').join(',') + `)
                    ORDER BY ` + alias + '.action_index ' + order;
    return { ids, rows };
}

// Distinct ids are exactly the single statement's page, so decorating them returns
// its rows. A repeated id (a duplicated blocks row) can split at the page edge, so
// that page runs as the single statement.
async function idsFirstRows(db, config, page, idsSql, query, queryArgs){
    const idRows = await db.doQuery(config, idsSql, queryArgs);
    const ids    = (idRows || []).map((row) => Number(row.action_index));
    if(!ids.length)
        return [];
    if(new Set(ids).size != ids.length)
        return db.doQuery(config, query, queryArgs);
    return db.doQuery(config, page.rows(ids.length), ids);
}

module.exports = { pageIdsSql, prunedBoundarySql, idsFirstPage, idsFirstRows };
