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
 * XChain Explorer - the generic query layer
 *
 * Proposal B stage 2: the two entry points every reader goes through (getData
 * for a shaped, cacheable page and getQuery for the raw pair), the WHERE and
 * OFFSET builders they call, and the limit helpers that clamp what a caller may
 * ask for. Nothing here knows what an action, a token or a checkpoint is: the
 * readers hand it a method name and a config and it hands back SQL.
 *
 * That is more than one file's worth, so the builders live in the sibling
 * directory and this file is their entry:
 *
 *   - query_sql/data.js          getData and getQuery, with the result cache
 *                                (data_cache.js), the row and count queries and
 *                                their bind args (data_rows.js), the per-page
 *                                post-passes (data_post.js) and the two
 *                                transports' paging clamps (query_limits.js)
 *   - query_sql/where_clauses.js the data-WHERE dispatcher, over the per-method
 *                                anchor table (where_anchors.js) and the three
 *                                clause families (where_action_clauses.js,
 *                                where_mirror_clauses.js, where_vote_clauses.js)
 *   - query_sql/offsets.js       explorer paging: the cursor predicate
 *                                (offset_cursors.js) and the page-boundary
 *                                reads (offset_boundaries.js)
 *   - this file                  the per-method result ceiling, the fulltext
 *                                term sanitizer and the detail-view limit
 *
 * They stay under ONE directory, and each builder stays one table read top to
 * bottom, for the reason they were one switch each: a cursor column or a filter
 * predicate that disagrees with the list query it pages is not a crash, it is a
 * page that silently resets to the newest row, so both have to be readable
 * against each other.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as class bodies (this file's and each part's) and
 * composeReaderParts folds their prototypes into the one object exported here,
 * so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('./reader_parts.js');

// The three method parts this entry composes with its own class body below.
const dataMethods   = require('./query_sql/data.js');
const whereMethods  = require('./query_sql/where_clauses.js');
const offsetMethods = require('./query_sql/offsets.js');

class QueryBuilder {
    getMaxMethodResults(method){
        let methods = {
            getBalances: 500,
            getHolders:  500
        }
        let max = (this.util.isInteger(methods[method])) ? methods[method] : 100;
        return max;
    }

    // Sanitize a search term for MATCH ... AGAINST (? IN BOOLEAN MODE). BOOLEAN MODE
    // gives +, -, ~, <, >, *, ", ( ), and @ operator meaning inside the bound value,
    // so an unsanitized term is a query-language injection into the search (a bare
    // '-foo' means "must NOT contain foo", '@10' is a distance operator, and an odd
    // quote is a syntax error the driver reports as a failed read). Strip them, then
    // hold the term to the same 3-character floor as the LIKE panels: InnoDB's
    // innodb_ft_min_token_size is 3, so a shorter term indexes to nothing anyway.
    // Returns '' when nothing usable survives, which callers answer as no results.
    fulltextTerm(term){
        if(this.util.isNull(term)) return '';
        let out = String(term).replace(/[+\-~<>()"*@]/g, ' ').replace(/\s+/g, ' ').trim();
        return (out.length < 3) ? '' : out;
    }

    // ── M4 composed detail views (spec explorer-coverage-completion, rows 26/28/30/31) ──
    //
    // Four single-record compositions backing the M4 detail pages. They follow
    // getXcall/getPoll: the method runs its own reads and returns [object] (null when the
    // subject does not exist), so getData takes its `typeof query === 'object'` branch and
    // the builder arg-assembly path (baseArgs then offsetArgs, count reusing baseArgs) never
    // applies to them.
    //
    // NONE of them consume config.data.sql.where.data, and that is deliberate rather than an
    // omission. A composition's spine and its sub-lists sit on different tables under
    // different aliases, so one shared WHERE fragment cannot be correct for all of them;
    // each leg carries its own predicate and binds its own args in strict left-to-right
    // text order. The consequence worth knowing: these four need no getQueryWhereSql branch,
    // so a route registered against any TYPE cannot 500 them with an unknown-column error.
    //
    // What they DO take from config.data.sql is `limit`, already clamped to
    // 1..getMaxMethodResults() by getQuery, and EVERY sub-list interpolates it. An unbounded
    // sub-list inside a composition pulls the same whole table a missing LIMIT pulls on a
    // list route; it is only harder to see, because the response looks like one record.
    detailLimit(config){
        let sql = config.data.sql;
        return (sql && this.util.isNumeric(sql.limit)) ? Number(sql.limit) : 100;
    }
}

module.exports = composeReaderParts(QueryBuilder.prototype, dataMethods, whereMethods, offsetMethods);
