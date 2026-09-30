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

// Kept local to the explorer. The consensus-side twin is
// xchain-indexer/src/consensus/list_tick_coin.js.
const LIST_TICK_COIN_SEPARATOR = ':';

function placeholders(values){
    return values.map(() => '?').join(',');
}

async function existingTickIds(db, config, ids){
    if(!ids.length) return new Set();
    let rows = await db.doQuery(config, `SELECT id
                    FROM index_tickers
                    WHERE id IN (` + placeholders(ids) + `)
                        AND block_index IS NOT NULL`, ids);
    return new Set((rows || []).map(row => Number(row.id)));
}

async function rosterTickMatches(db, config, tick, chain){
    let tickId = await db.getTickId(config, tick);
    let matches = [tick, chain + LIST_TICK_COIN_SEPARATOR + tick];
    if(!db.util.isNull(tickId))
        matches.push(chain + LIST_TICK_COIN_SEPARATOR + '^' + tickId);
    return matches;
}

async function rosterTickIds(db, config, membershipIndex, chain){
    let rows = await db.doQuery(config, `SELECT
                        li.item_id,
                        t1.tick AS item_text
                    FROM
                        list_items li
                        INNER JOIN index_tickers t1 ON (t1.id=li.item_id)
                    WHERE
                        li.action_index=?`, [membershipIndex]);
    if(!rows || !rows.length) return [];

    let ownChain = String(chain).toLowerCase();
    let items = rows.map(row => {
        let text = String(row.item_text);
        let separator = text.indexOf(LIST_TICK_COIN_SEPARATOR);
        if(separator < 0 || text.substring(0, separator).toLowerCase() !== ownChain)
            return { id: Number(row.item_id) };
        let tick = text.substring(separator + LIST_TICK_COIN_SEPARATOR.length);
        let match = /^\^(\d+)$/.exec(tick);
        let referencedId = match ? Number(match[1]) : null;
        return match && Number.isSafeInteger(referencedId) && referencedId >= 0
            ? { referenced_id: referencedId }
            : { tick };
    });
    let referenced = [...new Set(items
        .filter(item => Object.hasOwn(item, 'referenced_id'))
        .map(item => item.referenced_id))];
    let existing = await existingTickIds(db, config, referenced);
    let resolved = [];
    for(let item of items){
        let id;
        if(Object.hasOwn(item, 'id'))
            id = item.id;
        else if(Object.hasOwn(item, 'referenced_id'))
            id = existing.has(item.referenced_id) ? item.referenced_id : null;
        else
            id = await db.getTickId(config, item.tick);
        if(id !== null && id !== undefined && Number.isFinite(Number(id)))
            resolved.push(Number(id));
    }
    return [...new Set(resolved)];
}

module.exports = { LIST_TICK_COIN_SEPARATOR, rosterTickIds, rosterTickMatches };
