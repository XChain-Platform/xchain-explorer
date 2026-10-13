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
 * Plain functions: the builders are database-free, and the runner takes the
 * Database as `db` for doQuery.
 *
 ********************************************************************/

'use strict';

const { parseCountSql, pruneCountJoins } = require('./count_joins.js');

const BLOCK_LANE_RE = /(?:^|[^\w.])a1\.block_index=\?/;

// actions has no primary key, so InnoDB clusters it on the unique action_index and
// its block_index index runs in action_index order: driving the block lane from it
// reads one page and stops, for a dense block and a sparse one alike.
function drivesFromActions(parsed){
    const first = parsed.joins[0];
    return !!first && first.kind === 'INNER' && first.table === 'actions' && first.alias === 'a1'
        && first.on.replace(/\s+/g, '') === 'a1.action_index=' + parsed.alias + '.action_index'
        && BLOCK_LANE_RE.test(parsed.where);
}

// The ids leg of a list paged on <alias>.action_index: the pruned COUNT's FROM and
// WHERE (paging predicate included) selecting only the cursor, or null for a COUNT
// the parser does not read, which keeps the single statement.
function pageIdsSql(countSql, order, limit){
    const parsed = parseCountSql(pruneCountJoins(countSql));
    if(!parsed)
        return null;
    const tail = [parsed.where, 'ORDER BY {c} ' + order, 'LIMIT ' + limit];
    if(drivesFromActions(parsed)){
        const head = ['SELECT STRAIGHT_JOIN a1.action_index as action_index FROM actions a1',
            'INNER JOIN ' + parsed.table + ' ' + parsed.alias + ' ON (' + parsed.alias + '.action_index=a1.action_index)'];
        return head.concat(parsed.joins.slice(1).map(j => j.text), tail).join(' ').replace('{c}', 'a1.action_index');
    }
    const cursor = parsed.alias + '.action_index';
    return ['SELECT ' + cursor + ' as action_index FROM ' + parsed.table + ' ' + parsed.alias]
        .concat(parsed.joins.map(j => j.text), tail).join(' ').replace('{c}', cursor);
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

module.exports = { pageIdsSql, idsFirstPage, idsFirstRows };
