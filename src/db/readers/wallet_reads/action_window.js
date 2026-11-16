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
 * XChain Explorer - a time window as an action_index range
 *
 * blocks carries no index on block_time, but action_index rises with
 * block_index, so a [since, until] window is resolved in two steps:
 *
 *   resolveBlockWindow  one statement walking blocks backward from the tip on
 *                       the block_index index to the last block stamped before
 *                       `since` and the last stamped at or before `until`
 *   actionWindowTerms   WHERE terms turning those two heights, now constants,
 *                       into the first and last action_index inside them
 *
 * The heights must be constants by the time the action bounds are planned:
 * MariaDB answers MIN/MAX(block_index) over a constant range from the index
 * alone, and scans the whole actions index when the bound is a subquery.
 *
 ********************************************************************/

'use strict';

// Each half is a whole subquery so a missing bound names no block at all.
const AFTER_BLOCK_SQL   = '(SELECT wb1.block_index FROM blocks wb1 WHERE wb1.block_time < ? ORDER BY wb1.block_index DESC LIMIT 1)';
const THROUGH_BLOCK_SQL = '(SELECT wb2.block_index FROM blocks wb2 WHERE wb2.block_time <= ? ORDER BY wb2.block_index DESC LIMIT 1)';

/**
 * The block heights bounding a [since, until] window (unix seconds, either may
 * be null). Returns { afterBlock, throughBlock, empty }: actions qualify above
 * afterBlock and at or below throughBlock, a null height leaves that side open,
 * and `empty` is true when no block is stamped at or before `until`.
 */
async function resolveBlockWindow(db, config, since, until){
    const hasSince = since !== null && since !== undefined;
    const hasUntil = until !== null && until !== undefined;
    if(!hasSince && !hasUntil) return { afterBlock: null, throughBlock: null, empty: false };
    const args = [];
    if(hasSince) args.push(since);
    if(hasUntil) args.push(until);
    const query = 'SELECT ' + (hasSince ? AFTER_BLOCK_SQL : 'NULL') + ' as after_block, '
        + (hasUntil ? THROUGH_BLOCK_SQL : 'NULL') + ' as through_block';
    const rows = await db.doQuery(config, query, args);
    const row  = (rows && rows[0]) || {};
    const height = (value) => (value === null || value === undefined) ? null : Number(value);
    const throughBlock = height(row.through_block);
    return { afterBlock: height(row.after_block), throughBlock, empty: hasUntil && throughBlock === null };
}

/**
 * WHERE terms bounding `column` to the actions of a resolved block window.
 *
 * @returns {{ terms: string[], args: number[] }}
 */
function actionWindowTerms(column, window){
    const terms = [];
    const args  = [];
    if(window && window.afterBlock !== null && window.afterBlock !== undefined){
        terms.push(column + ` >= (SELECT MIN(wl1.action_index) FROM actions wl1
                        WHERE wl1.block_index = (SELECT MIN(wl2.block_index) FROM actions wl2 WHERE wl2.block_index > ?))`);
        args.push(window.afterBlock);
    }
    if(window && window.throughBlock !== null && window.throughBlock !== undefined){
        terms.push(column + ` <= (SELECT MAX(wh1.action_index) FROM actions wh1
                        WHERE wh1.block_index = (SELECT MAX(wh2.block_index) FROM actions wh2 WHERE wh2.block_index <= ?))`);
        args.push(window.throughBlock);
    }
    return { terms, args };
}

function placeholders(count){
    return new Array(count).fill('?').join(',');
}

module.exports = { resolveBlockWindow, actionWindowTerms, placeholders };
