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
 * XChain Explorer - the page window a request asked for
 *
 * Everything the row loop needs to know before it walks the result set: where the
 * page starts, where it stops, and whether this is a cursor-paged jump to the last
 * page, which has no server-computed boundary to test against.
 *
 * It is a function rather than a method because it reads nothing off the explorer
 * beyond the two collaborators handed in, so a caller can work out a window for a
 * request config without an explorer instance.
 *
 ********************************************************************/

'use strict';

/**
 * Work out the page window this request asked for.
 *
 * @param {object} util the explorer's utility helper
 * @param {object} db the explorer's database
 * @param {object} cfg the request config processRequest built
 * @returns {{start: number, limit: number, offset: (string|boolean), action: (string|boolean), cursorLast: boolean}}
 */
function pagingWindow(util, db, cfg){
    let max    = db.getMaxMethodResults(cfg.data.method);
    let q      = (cfg.data && cfg.data.query) ? cfg.data.query : false;
    let start  = (q && q.start  && util.isInteger(Number(q.start)))  ? q.start  : 0;
    let limit  = (q && q.limit  && util.isInteger(Number(q.limit)))  ? q.limit  : max;
    let length = (q && q.length && util.isInteger(Number(q.length))) ? q.length : 10;
    let offset = (cfg.data && cfg.data.offset && !util.isNull(cfg.data.offset.start))  ? cfg.data.offset.start  : false;
    let action = (cfg.data && cfg.data.offset && !util.isNull(cfg.data.offset.action)) ? cfg.data.offset.action : false;
    let method = cfg.data.method;
    // Cursor-paged list views (anchor_actions, slash_events, the hub mirrors, etc.) carry
    // no server-computed boundary on a jump-to-last: their main query already returns the
    // exact final page (ORDER BY <cursor> ASC LIMIT n), so there is no `offset` to satisfy
    // the keep test below. The `cnt > start` window test then drops every row (cnt is
    // 1-based within the single returned page, never exceeding `start`). Keep all rows in
    // that case, mirroring how the `|| offset` branch keeps a cursor-windowed page.
    let cursorLast = (action=='last') && (db.cursorPagedMethods || []).includes(method);

    // Clamp pagination values to safe ranges
    start  = Math.max(0, Number(start));
    limit  = Math.max(1, Math.min(Number(limit), max));
    length = Math.max(1, Number(length));

    // SQL OFFSET already handled pagination for API requests; return all rows
    if(cfg.type=='api'){
        start = 0;
    }
    // Explorer requests set their own limit from the page length and start position.
    if(cfg.type=='explorer'){
        // Limit results to 100 max (except in special cases where we can not use an offset)
        if(length > 100 && !['getHolders','getBalances','getCredits','getDebits'].includes(cfg.data.method))
            length = 100;
        // Even the offset-exempt methods carry an explicit finite ceiling so one
        // query parameter cannot drive an unbounded DB scan + response serialization;
        // the app-layer invariant no longer rests solely on db/index.js's own clamp.
        else if(length > 10000)
            length = 10000;
        limit = util.bcadd(start, length);
    }

    return { start, limit, offset, action, cursorLast };
}

module.exports = { pagingWindow };
