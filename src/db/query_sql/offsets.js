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
 * XChain Explorer - explorer paging: the cursor predicate and the page bounds
 *
 * One part of src/db/query_sql.js (the entry composes it through
 * composeReaderParts). Two methods: getQueryOffsetSql turns the resolved page
 * bounds into the ` AND <cursor> < ?` predicate the list query carries, and
 * getQueryOffsets resolves those bounds by reading the list's own edge rows.
 *
 * The cursor column each method pages on lives in offset_cursors.js and the
 * boundary reads in offset_boundaries.js; both must stay in lockstep with the
 * ORDER BY of the list query being paged, which is why the builders still sit
 * beside each other under one directory.
 *
 * Authored as a class body whose prototype is exported, like every other family
 * under src/db/: `this` is the Database instance at call time.
 *
 ********************************************************************/

'use strict';

const { cursorField } = require('./offset_cursors.js');
const { historyCursor, pagesOverBlocks, boundaryWhere,
    firstLastOffset, stopOffset } = require('./offset_boundaries.js');

class QueryOffsets {

    /******************************************************************
     * Explorer Paging / Offset specific code
     *****************************************************************/

    // table `m` is a universal reference to the main action table
    async getQueryOffsetSql(config){
        let method = config.data.method;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start  = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? this.util.sanitizeInt(offset.start, false) : false;
        let stop   = (offset && !this.util.isNull(offset.stop) && this.util.isNumeric(offset.stop)) ? this.util.sanitizeInt(offset.stop, false) : false;
        if(start === false || stop === false) { /* sanitizeInt handles NaN/Infinity */ }
        let sql    = '';
        let args   = [];
        if(method=='getBlocks')
            stop = false;
        if(action && start !== false){
            // hardcoded whitelist, never from user input
            let field = cursorField(method);
            if(action=='prev'){
                sql = ` AND ` + field + ` > ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` < ?`;
                    args.push(stop);
                }
            } else if(action=='last'){
                sql = ` AND ` + field + ` <= ?`;
                args.push(start);
            } else {
                sql = ` AND ` + field + ` < ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` > ?`;
                    args.push(stop);
                }
            }
        }
        return [sql, args];
    }

    async getQueryOffsets(config, offset1, length){
        let offset2 = false;
        let method  = config.data.method;
        let type    = config.data.type;
        let offset  = (config.data.offset) ? config.data.offset : false;
        let action  = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let q       = (config.data.query) ? config.data.query : false;
        if(['getBalances','getHolders','getTransaction','getSearch','getMarkets','getMarket'].includes(method))
            return [];
        // token/subtoken searches paginate by fetch-and-slice (no action_index offsets)
        if(method=='getTokens' && ['token','subtoken'].includes(type))
            return [];
        let { hCursor, hSource } = historyCursor(method, type);
        let { where, whereArgs } = await boundaryWhere(this, config);
        let table = String(method).toLowerCase().replace('get','');
        if(!this.actionTables.includes(table) && !['blocks','tokens','history','files','markets','market'].includes(table)){
            // The boundary-discovery query below keys off this derived table name, which
            // does not exist for these methods (anchor_actions, slash_events, the hub
            // governance/match mirrors, etc.), so it cannot run. It is not needed: the
            // main list query already filters and orders on the right cursor column. For
            // the known cursor-paged views, pass the inbound client cursor through
            // unchanged (offset1) so next/prev advance; returning [] here discards it and
            // resets every page to the newest rows. Unknown methods keep the old no-op.
            if(this.cursorPagedMethods.includes(method))
                return [offset1, false];
            return [];
        }
        let ctx = { method, type, action, table, where, whereArgs, hCursor, hSource, length,
            pagesOverBlocks: pagesOverBlocks(table) };
        if(['first','last'].includes(action))
            offset1 = await firstLastOffset(this, config, ctx, offset1, offset);
        if(offset1){
            // Same predicate as the boundary query above, deliberately: this branch reads
            // offset1 as a BLOCK INDEX, and only the blocks query returns one.
            if(ctx.pagesOverBlocks){
                if(action=='last'){
                    offset2 = this.util.bcsub(this.util.bcadd(offset1,1),q.length);
                } else {
                    offset2 = this.util.bcsub(this.util.bcsub(offset1,1),q.length);
                }
            } else {
                offset2 = await stopOffset(this, config, ctx, offset1);
            }
        }
        return [offset1, offset2];
    }
}

module.exports = QueryOffsets.prototype;
