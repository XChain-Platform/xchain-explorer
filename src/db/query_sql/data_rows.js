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
 * XChain Explorer - running a list query and binding its arguments
 *
 * One part of src/db/query_sql.js: the step between the SQL getQuery built and
 * the rows getData shapes. It assembles the bind arguments in the strict
 * left-to-right order the placeholders appear in (data-WHERE args, then the
 * offset args, then the API OFFSET), runs the row query, and runs the count
 * query on the base args alone.
 *
 * Plain functions, not a class body: they take the Database as `db` for
 * doQuery and this.util, and nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

// Align the data-WHERE bind args with their placeholders. getQueryWhereSql only
// adds a data-WHERE placeholder when a TYPE (address/token/block/...) is set, so a
// pure list-all request (no QUERY and no TYPE) has none. Many action methods still
// seed args=[config.data.search] (= [undefined] here); that phantom prepends to the
// offset args, shifting `m.action_index < ?` to bind NULL and returning zero rows.
// Drop the phantom for pure list-all so only the offset args remain. Typed requests
// (search and/or a resource type present) keep the method's args, or the
// single-search fallback.
//
// The phantom is dropped by VALUE, not by discarding the whole array: a method can
// add a placeholder of its own that has nothing to do with search or type, and
// discarding its args left that placeholder unbound. getCrossChainMatches appends
// `AND m.network = ?` on every request, so a bare
// GET /{COIN}/api/cross_chain_matches answered 500 "Parameter at position 1 is not
// set" on any install with the mandatory checkpoint schema actually configured.
// On the list-all path the seeded search is null/undefined by construction, so
// filtering nulls removes exactly the phantom and nothing a method meant to bind.
function listQueryArgs(db, config, args){
    let baseArgs;
    let listAll = !config.data.search && !config.data.type;
    if(Array.isArray(args))
        baseArgs = listAll ? args.filter(a => !db.util.isNull(a)) : args;
    else if(listAll)
        baseArgs = [];
    else if(args && typeof args === 'object')
        baseArgs = args;
    else
        baseArgs = db.util.isNull(config.data.search) ? [] : [config.data.search];
    return baseArgs;
}

// Runs the row query and, when the method built one, the count query. Returns
// the [data, total] pair getData carries on to its post-passes.
async function runListQuery(db, config, query, args, count){
    let data  = [];
    let total = null;
    let baseArgs   = listQueryArgs(db, config, args);
    let queryArgs  = [...baseArgs];
    let offsetArgs = config.data.sql.where.offsetArgs;
    if(offsetArgs && offsetArgs.length)
        queryArgs.push(...offsetArgs);
    // Append SQL OFFSET for API pagination (page > 1)
    if(config.type == 'api' && config.data.sql.apiOffset > 0){
        query += ' OFFSET ?';
        queryArgs.push(config.data.sql.apiOffset);
    }
    if(query!='')
        data = await db.doQuery(config, query, queryArgs);
    // Count query uses only base args (no offset/limit placeholders)
    if(count){
        let rows = await db.doQuery(config, count, baseArgs);
        total = (rows) ? Number(rows[0].total) : 0;
    }
    return [data, total];
}

module.exports = { listQueryArgs, runListQuery };
