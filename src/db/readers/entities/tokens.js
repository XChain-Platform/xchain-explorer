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
 * XChain Explorer - the token reads
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). One token with everything its page quotes (supply,
 * issuance, controllers, market and project links) and the FILE actions
 * linked to that token.
 *
 * The linked-file read stays beside the token read it decorates: it exists
 * only to fill a section of that page and shares its tick resolution.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The columns and joins one token's detail reads. The caller appends the WHERE lane
// it resolved (by name or by ^<id>) and the LIMIT, which is the only part that
// varies per request; the SQL comments are the contract for what the odd columns
// are for, so they stay with the text.
const TOKEN_DETAIL_SELECT = `SELECT
                        t2.tick,
                        -- F3 (id-determinism): expose tick_id for SDK ^<id> compaction ONLY when it
                        -- is in the deterministic set (index_tickers.block_index IS NOT NULL). An
                        -- out-of-band id is not reproducible across nodes, so the SDK must never
                        -- compact to it (the indexer would reject the ^id). Gates the SDK-facing
                        -- info.tick_id only; the t1.tick_id lookup/WHERE below is unaffected.
                        (CASE WHEN t2.block_index IS NOT NULL THEN t1.tick_id ELSE NULL END) AS tick_id,
                        t1.supply,
                        t1.max_supply,
                        t1.max_mint,
                        t1.decimals,
                        t1.description,
                        t1.lock_max_supply,
                        t1.lock_mint,
                        t1.lock_mint_supply,
                        t1.lock_max_mint,
                        t1.lock_description,
                        t1.lock_sleep,
                        t1.lock_callback,
                        t1.callback_block,
                        t3.tick as callback_tick,
                        t4.decimals as callback_decimals,
                        t4.coin_price as callback_coin_price,
                        t1.callback_amount,
                        t1.allow_list,
                        t1.block_list,
                        t1.mint_address_max,
                        t1.mint_start_block,
                        t1.mint_stop_block,
                        a1.address as owner,
                        t1.coin_price,
                        t1.coin_floor,
                        t1.escrow_action_index,
                        -- Token-bridge state (ISSUE format 7, xchain-token-bridge.md section 8).
                        -- The wallet's tokenInfo projection reads these off the grouped row, so
                        -- where each lands matters: lock_bridge carries the lock_ prefix and the
                        -- grouping loop below folds it into locks.bridge, while bridge_chains,
                        -- min_depth and bridged match no group prefix and land in info. Omitting
                        -- them made every wallet bridge surface read null in production.
                        t1.bridge_chains,
                        t1.min_depth,
                        t1.lock_bridge,
                        t1.bridged
                    FROM
                        tokens t1
                        LEFT  JOIN index_tickers      t2 ON (t2.id=t1.tick_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=t1.owner_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=t1.callback_tick_id)
                        LEFT  JOIN tokens             t4 ON (t4.tick_id=t1.callback_tick_id)
                    WHERE
                        `;

// The response shape a token detail is filled into, with every group present and
// empty. Declared up front rather than grown field by field so a reader can see
// the whole contract, and so a column the grouping loop cannot place lands in
// info rather than inventing a group. A module function rather than a method:
// Database.prototype carries the family's public readers and nothing else, so a
// cut made for length adds no name to it. Same for the two below.
function emptyTokenShape(config){
    return {
        info: {
            coin: config.coin,   // Current COIN (BTC, LTC, DOGE, etc)
            tick: null,
            description : null,
            owner: null
        },
        callback: {
            tick: null,  // Callback tick
            price: null, // Callback tick price (tokens.coin_price)
            block: null, // Callback block
            amount: null // Callback amount
        },
        market: {
            price: null, // Tick  price (tokens.coin_price)
            floor: null, // Floor price (tokens.floor_price)
        },
        lists: {
            allow: null,
            block: null
        },
        locks: {
            bridge: false,  // LOCK_BRIDGE: freezes BRIDGE_CHAINS/MIN_DEPTH forever
            callback: false,
            description: false,
            max_mint: false,
            max_supply: false,
            mint: false,
            mint_supply: false,
            sleep: false
        },
        mints: {
            max: null,
            address_max: null,
            start_block: null,
            stop_block: null
        },
        supply: {
            current: null,
            max: null
        }
    };
}

// Folds one tokens row into the grouped shape above, by column-name prefix. The
// wallet reads these groups, so where a column lands is a wire contract: a column
// matching no prefix is info, which is why a new one has to be checked against the
// prefixes rather than just added to the SELECT.
function groupTokenRow(db, data, row){
    for( let key in row ){
        let name  = key;
        let value = row[key];
        // Skip/Ignore any decimal fields
        if(String(key).includes('decimals'))
            continue;
        // Group LOCK fields
        if(String(key).substring(0,5)=='lock_'){
            name  = String(key).replace('lock_','');
            value = (row[key]=="1") ? true : false;
            data.locks[name] = value;
        // Group LIST fields
        } else if(String(key).substring(5,10)=='_list'){
            name = String(key).replace('_list','');
            data.lists[name] = (db.util.isNumeric(value)) ? Number(value) : null;
        // Group MINT fields
        } else if(String(key).substring(0,5)=='mint_' || key=='max_mint'){
            name = String(key).replace('mint_','').replace('_mint','');
            data.mints[name] = Number(value);
        // Group CALLBACK fields
        } else if(String(key).substring(0,9)=='callback_'){
            name = String(key).replace('callback_','').replace('coin_','');
            if(name=='amount'){
                data.callback[name] = db.util.bcformat(value, row['callback_decimals']);
            } else {
                data.callback[name] = value;
            }
        // Group SUPPLY fields
        } else if(['supply','max_supply'].includes(key)){
            if(name=='supply')     name = 'current';
            if(name=='max_supply') name = 'max';
            data.supply[name] = db.util.bcformat(value, row['decimals']);
        // Group COIN fields
        } else if(String(key).substring(0,5)=='coin_'){
            name = String(key).replace('coin_','');
            data.market[name] = Number(value);
        } else {
            data.info[name] = value;
        }
    }
}

// The fields a token page carries that are not columns of the tokens row: its own
// decimals and ticker id, and the project, controller, poll and linked-file
// surfaces each read by the family that owns them.
async function attachTokenSurfaces(db, config, data, row){
    // Expose the token's own decimals (the grouping loop above skips every
    // *decimals* column so callback_decimals doesn't leak into info).
    // Clients need it for NFT-pattern classification (nft-standard.md:
    // DECIMALS=0 AND LOCK_MAX_SUPPLY=1 (the lock is already in locks.max_supply).
    data.info.decimals   = Number(row.decimals);
    data.supply.decimals = Number(row.decimals);
    // Expose the immutable numeric ticker id (index_tickers.id) so clients
    // (e.g. the SDK) can compact a ticker name into its `^<id>` wire form.
    data.info.tick_id    = (row.tick_id !== undefined && row.tick_id !== null) ? Number(row.tick_id) : null;
    // Project registry surfaces (protocol/project-registry.md):
    // projects = registries whose CURRENT roster includes this token
    // (drives the "Official: part of X" banner); registry = this token's
    // own roster metadata when it IS a project (null otherwise).
    data.projects = await db.getTokenProjects(config, data.info.tick);
    data.registry = await db.getProjectRosterInfo(config, data.info.tick);
    // Controller bindings still gating this token's native actions
    // (protocol/controller-bound-tokens.md). [] when nothing gates.
    data.controllers = await db.getTokenControllerBindings(config, data.info.tick);
    // Open governance polls over this token (VOTE v0, poll_status='open').
    // Drives the token page's Active Governance card: voter apathy is the
    // attack surface (a poll nobody sees is a poll nobody out-votes), so
    // open polls surface on the token itself, binding polls flagged.
    data.open_polls = await db.getTokenOpenPolls(config, data.info.tick);
    // Files LINKed to this token (the NFT pattern: LINK v0 binds a FILE action to a
    // token's ISSUE). The Files TAB already lists these, but the info column - the
    // part of the page a reader actually looks at for what a token IS - said "No
    // additional information is available" beside a token carrying on-chain artwork.
    // Same rows the tab reads (mappings_files), so nothing new is indexed.
    data.linked_files = await db.getTokenLinkedFiles(config, data.info.tick);
}

class EntityTokenReaders {
    async getToken(config){
        let data  = null;
        // A token may be looked up by its full name (PEPE) or by its numeric id
        // with a caret prefix (^1234). For the id form, filter on tick_id instead
        // of the name so both references resolve to the same token.
        let search   = String(config.data.search);
        let tickIdRef = (search.charAt(0) === '^' && this.util.isNumeric(search.substring(1)));
        let tickWhere = tickIdRef ? 't1.tick_id=?' : 't2.tick=?';
        let args  = [ tickIdRef ? Number(search.substring(1)) : config.data.search ];
        let query = TOKEN_DETAIL_SELECT + tickWhere + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            data = emptyTokenShape(config);
            groupTokenRow(this, data, row);
            await attachTokenSurfaces(this, config, data, row);
        }
        return [data];
    }

    // Files LINKed to a token, newest link first. `title`/`name`/`type` drive the token
    // page's Linked Files card and its artwork pick; `gated` tells the page a file's bytes
    // are gated behind a token balance, so it can say so instead of offering a raw link
    // that will refuse. Capped: this feeds an info card, not a paged list.
    async getTokenLinkedFiles(config, tick){
        if(this.util.isNull(tick)) return [];
        let rows = await this.doQuery(config,
            `SELECT
                f1.action_index,
                f1.name,
                f1.title,
                t3.type,
                b1.block_index,
                (gf.action_index IS NOT NULL) as gated
            FROM
                mappings_files m
                INNER JOIN index_tickers      t4 ON (t4.id=m.id AND t4.tick=?)
                INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id AND s1.status='valid')
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
            WHERE
                m.type_id=1
            ORDER BY m.action_index DESC
            LIMIT 10`, [tick]);
        if(!rows || !rows.length) return [];
        return rows.map(r => ({
            action_index: Number(r.action_index),
            name:         r.name,
            title:        r.title,
            type:         r.type,
            block_index:  Number(r.block_index),
            gated:        Number(r.gated) === 1
        }));
    }
}

module.exports = EntityTokenReaders.prototype;
