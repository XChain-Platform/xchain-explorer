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
 * XChain Explorer - DELEGATE revoke parsing and LIST membership
 *
 * The wire parse for a DELEGATE v2/v3 revoke target, the route code to
 * coin/network split, and the LIST root, head and current-membership resolvers
 * the action detail and list pages share.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

const listEditResolution = require('../../../list_edit_resolution_activation');

class ActionListMembershipReaders {
    /******************************************************************
     * Commonly used functions 
     *****************************************************************/

    // Extract the revoke target of a DELEGATE v2/v3 from the transaction's decoded
    // action string. Returns { pubkey } for v2 (capability revoke) and
    // { pubkey, target, tick } for v3 (contract-targeted revoke), or null when the
    // wire is absent/unparseable. Locates the `DELEGATE|<fmt>|...` segment so it works
    // for a standalone DELEGATE and one nested in a BATCH (`VERSION|CMD;CMD`); the
    // 64-hex signing pubkey is a fixed-width token, so the match is unambiguous.
    parseDelegateRevokeWire(wire, fmt){
        if(this.util.isNull(wire)) return null;
        let str = String(wire);
        if(Number(fmt)===3){
            let m = str.match(/DELEGATE\|3\|([0-9a-fA-F]{64})\|([0-9]+)\|([^;|]+)/);
            return m ? { pubkey: m[1], target: m[2], tick: m[3] } : null;
        }
        let m = str.match(/DELEGATE\|2\|([0-9a-fA-F]{64})/);
        return m ? { pubkey: m[1] } : null;
    }

    // Split a route code ('BTC' / 'TBTC' / 'RDOGE') into its base coin and
    // network. Prefixed networks are tested first so 'TBTC' is not read as a
    // mainnet coin literally named 'TBTC'. Returns null when the code names no
    // configured coin, which callers must treat as "cannot mirror consensus
    // here" rather than as mainnet.
    // @param {config}  object  request config carrying the route code in .coin
    async resolveCoinNetwork(config){
        let code = String((config && config.coin) || '').toUpperCase();
        if(!code) return null;
        let full     = await this.configInfo.getConfig();
        let networks = full['COIN_NETWORKS'] || {};
        let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        for(let network in prefixes){
            let p = prefixes[network];
            if(p && code.startsWith(p)){
                let base = code.slice(p.length);
                if(networks[base]) return { coin: base, network };
            }
        }
        return networks[code] ? { coin: code, network: 'mainnet' } : null;
    }

    // Walk a SET of LIST references up to the CREATE actions that root their edit
    // chains, one query per hop for the whole set instead of one per list.
    // Mirrors the indexer's db.getListRootIndex: an edit row carries the index of
    // the list it edits in lists.list_action_index and a create carries NULL, and
    // the hop count is bounded so a malformed chain cannot spin. The frontier is
    // deduped every hop, and a chain that revisits an index it has already stood on
    // stops there, so a cycle costs one wasted hop rather than looping.
    // @param {action_indexes}  array  ACTION_INDEXes of LIST creates or edits
    // @return {object}  map of String(input index) -> root action_index (number)
    async getListRootIndexes(config, action_indexes){
        let roots   = {};   // input index -> the index the walk currently stands on
        let seen    = {};   // input index -> set of indexes already visited
        let pending = {};   // input indexes whose walk has not terminated
        for(let action_index of (action_indexes || [])){
            let n = Number(action_index);
            if(!Number.isFinite(n)) continue;
            let key = String(n);
            if(key in roots) continue;
            roots[key] = n;
            seen[key]  = {};
            pending[key] = true;
        }
        for(let hop = 0; hop < 16; hop++){
            let keys = Object.keys(pending);
            if(keys.length == 0) break;
            let frontier = [...new Set(keys.map(key => roots[key]))];
            let rows = await this.doQuery(config, 'SELECT action_index, list_action_index FROM lists WHERE action_index IN (' +
                                                  frontier.map(() => '?').join(',') + ')', frontier);
            let parents = {};
            for(let row of (rows || [])) parents[String(Number(row['action_index']))] = row['list_action_index'];
            for(let key of keys){
                let at = String(roots[key]);
                // Already stood here on an earlier hop: the chain is cyclic, stop.
                if(seen[key][at]){ delete pending[key]; continue; }
                seen[key][at] = true;
                // No row (dangling reference) or a NULL parent (a create): this is the root.
                if(!(at in parents) || this.util.isNull(parents[at])){ delete pending[key]; continue; }
                roots[key] = Number(parents[at]);
            }
        }
        return roots;
    }

    // Walk a LIST reference up to the CREATE action that roots its edit chain.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListRootIndex(config, action_index){
        let roots = await this.getListRootIndexes(config, [action_index]);
        let key   = String(Number(action_index));
        return (key in roots) ? roots[key] : action_index;
    }

    // Resolve a SET of LIST references to the actions whose list_items rows ARE
    // those lists' CURRENT membership, in a bounded number of queries regardless
    // of set size. Mirrors the indexer's db.getListHeadIndex per list, including
    // the ordering (the newest valid action in the chain; action_index is unique
    // and monotonic, so MAX is the same total order as ORDER BY DESC LIMIT 1) and
    // the valid-only filter, so the explorer displays the membership the chain
    // actually enforces. A chain with no valid edits resolves to its own root.
    // @param {action_indexes}  array  ACTION_INDEXes of LIST creates or edits
    // @return {object}  map of String(input index) -> head action_index (number)
    async getListHeadIndexes(config, action_indexes){
        let roots    = await this.getListRootIndexes(config, action_indexes);
        let distinct = [...new Set(Object.values(roots))];
        if(distinct.length == 0) return roots;
        let query = `SELECT
                        l.list_action_index AS root,
                        MAX(l.action_index) AS head
                    FROM
                        lists l
                        INNER JOIN index_statuses s ON (s.id=l.status_id)
                    WHERE
                        l.list_action_index IN (` + distinct.map(() => '?').join(',') + `)
                        AND s.status='valid'
                    GROUP BY l.list_action_index`;
        let rows  = await this.doQuery(config, query, distinct);
        let heads = {};
        for(let row of (rows || [])) heads[String(Number(row['root']))] = Number(row['head']);
        let out = {};
        for(let key in roots){
            let root = String(roots[key]);
            out[key] = (root in heads) ? heads[root] : roots[key];
        }
        return out;
    }

    // Resolve a LIST reference to the action whose list_items rows ARE the list's
    // CURRENT membership: the newest VALID action in its edit chain, or the create
    // itself when it has no valid edits.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListHeadIndex(config, action_index){
        let heads = await this.getListHeadIndexes(config, [action_index]);
        let key   = String(Number(action_index));
        return (key in heads) ? heads[key] : action_index;
    }

    // Is list-edit read resolution active for this coin at the CURRENT TIP?
    // Every display that resolves an edit chain asks this first, because
    // below the flag day consensus still reads the pinned create's rows and the
    // explorer must not advertise a rule the chain is not applying yet. An
    // unresolvable coin/network is treated as inactive (the safe side).
    async isListEditResolutionActiveAtTip(config){
        let resolved = null;
        try {
            resolved = await this.resolveCoinNetwork(config);
        } catch(e){ /* config momentarily unavailable: fall through to inactive */ }
        if(!resolved) return false;
        let tip = await this.getMaxBlockIndex(config);
        return listEditResolution.isListEditResolutionActive(tip, resolved.network, resolved.coin);
    }

    // Current membership of the list a LIST action belongs to (the display leg).
    //
    // A LIST edit writes the resulting membership under the EDIT's own
    // action_index and never touches the parent's rows, so the create's
    // list_items are its create-time snapshot forever. Consumers pin a list by
    // its CREATE index - a bet feed's ALLOW_LIST is exactly that - so the page a
    // "who may bet on this market" link lands on was showing membership the chain
    // had already stopped enforcing.
    //
    // Gated on the same per-chain flag day as the indexer's read path, evaluated
    // against the TIP, because below the height consensus still reads the create's
    // rows and the explorer must not advertise a rule the chain is not applying
    // yet. An unresolvable coin/network is treated as inactive (the safe side).
    // @param {action_index}  integer  ACTION_INDEX of the LIST action being viewed
    // @param {type}          integer  list type (1 = tick, 2 = address)
    async getListCurrentMembership(config, action_index, type){
        let active = await this.isListEditResolutionActiveAtTip(config);
        let state  = { edit_resolution_active: active, membership_action_index: Number(action_index), current_list: null };
        if(!active) return state;
        let head = await this.getListHeadIndex(config, action_index);
        state.membership_action_index = Number(head);
        let rows = await this.doQuery(config, `SELECT
                        a1.address,
                        t1.tick
                    FROM
                        list_items l1
                        LEFT JOIN index_addresses a1 ON (a1.id=l1.item_id)
                        LEFT JOIN index_tickers   t1 ON (t1.id=l1.item_id)
                    WHERE
                        l1.action_index=?`, [head]);
        let items = [];
        for(let row of (rows || [])){
            if(Number(type) == 1) items.push(row.tick);
            if(Number(type) == 2) items.push(row.address);
        }
        state.current_list = items.sort();
        return state;
    }
}

module.exports = ActionListMembershipReaders.prototype;
