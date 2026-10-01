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

const LATEST_ROSTER_LINKS = `FROM (
                        SELECT
                            i1.tick_id,
                            MAX(l.action_index) AS link_action_index
                        FROM
                            links l
                            INNER JOIN index_statuses s1 ON (s1.id=l.status_id AND s1.status='valid')
                            INNER JOIN index_coins    c1 ON (c1.id=l.coin1_id AND c1.coin=?)
                            INNER JOIN index_coins    c2 ON (c2.id=l.coin2_id AND c2.coin=?)
                            INNER JOIN issues         i1 ON (i1.action_index=l.coin2_action_index)
                            INNER JOIN index_statuses s2 ON (s2.id=i1.status_id AND s2.status='valid')
                            INNER JOIN lists          ls ON (ls.action_index=l.coin1_action_index AND ls.type='1')
                            INNER JOIN index_statuses s3 ON (s3.id=ls.status_id AND s3.status='valid')
                        GROUP BY i1.tick_id
                    ) latest
                        INNER JOIN links lk ON (lk.action_index=latest.link_action_index)`;

const ROSTER_SELECT = `SELECT
                        t1.tick AS project,
                        latest.link_action_index,
                        lk.coin1_action_index AS roster_action_index
                    `;

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

async function directMembershipRows(db, config, match, chain, caseFolded){
    let query = ROSTER_SELECT + LATEST_ROSTER_LINKS + `
                        INNER JOIN list_items li ON (li.action_index=lk.coin1_action_index)
                        INNER JOIN index_tickers t2 ON (t2.id=li.item_id AND ` +
                            (caseFolded ? `LOWER(t2.tick)=LOWER(?)` : `t2.tick=?`) + `)
                        INNER JOIN index_tickers t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC
                    LIMIT 1000`;
    return await db.doQuery(config, query, [chain, chain, match]) || [];
}

async function rostersByDirectMembership(db, config, tick, chain){
    let rows = await directMembershipRows(db, config, tick, chain, false);
    let matches = await rosterTickMatches(db, config, tick, chain);
    rows.push(...await directMembershipRows(db, config, matches[1], chain, true));
    if(matches.length === 3)
        rows.push(...await directMembershipRows(db, config, matches[2], chain, false));
    let unique = new Map();
    for(let row of rows)
        unique.set([row.project, row.link_action_index, row.roster_action_index].join('\0'), row);
    return [...unique.values()]
        .sort((a, b) => Number(b.link_action_index) - Number(a.link_action_index))
        .slice(0, 1000)
        .map(r => ({
            project:                 r.project,
            link_action_index:       Number(r.link_action_index),
            roster_action_index:     Number(r.roster_action_index),
            membership_action_index: Number(r.roster_action_index)
        }));
}

async function rostersByResolvedListHead(db, config, tick, chain){
    let candidates = await db.doQuery(config, ROSTER_SELECT + LATEST_ROSTER_LINKS + `
                        INNER JOIN index_tickers t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC
                    LIMIT 1000`, [chain, chain]);
    if(!candidates || !candidates.length) return [];
    let heads   = await db.getListHeadIndexes(config, candidates.map(r => Number(r.roster_action_index)));
    let rosters = candidates.map(r => ({
        project:                 r.project,
        link_action_index:       Number(r.link_action_index),
        roster_action_index:     Number(r.roster_action_index),
        membership_action_index: Number(heads[String(Number(r.roster_action_index))])
    }));
    let indexes = [...new Set(rosters.map(r => r.membership_action_index))];
    let readMembers = async (match, caseFolded) => await db.doQuery(config, `SELECT
                        li.action_index
                    FROM
                        list_items li
                        INNER JOIN index_tickers t2 ON (t2.id=li.item_id AND ` +
                            (caseFolded ? `LOWER(t2.tick)=LOWER(?)` : `t2.tick=?`) + `)
                    WHERE
                        li.action_index IN (` + placeholders(indexes) + `)
                    GROUP BY li.action_index`, [match, ...indexes]) || [];
    let members = await readMembers(tick, false);
    let matches = await rosterTickMatches(db, config, tick, chain);
    members.push(...await readMembers(matches[1], true));
    if(matches.length === 3)
        members.push(...await readMembers(matches[2], false));
    let listing = new Set(members.map(row => Number(row.action_index)));
    return rosters.filter(r => listing.has(r.membership_action_index));
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
    if(!rows || !rows.length){
        let ids = [];
        Object.defineProperty(ids, 'item_count', { value: 0 });
        return ids;
    }

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
    let ids = [...new Set(resolved)];
    Object.defineProperty(ids, 'item_count', { value: rows.length });
    return ids;
}

module.exports = {
    LIST_TICK_COIN_SEPARATOR,
    rosterTickIds,
    rostersByDirectMembership,
    rostersByResolvedListHead
};
