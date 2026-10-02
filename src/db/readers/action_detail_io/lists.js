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
 * XChain Explorer - DELEGATE revoke parsing and LIST membership readers.
 ********************************************************************/

'use strict';

// The LIST_EDIT_RESOLUTION flag day is a registry row read by its literal key
// (W5), per coin: the <COIN>:<network> slot wins over the bare network slot.
const gateRegistry = require('../../../consensus/gate_registry');
const { isMissingTableError } = require('../../schema_probe.js');
const LIST_EDIT_RESOLUTION_KEY = 'list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION';

class ActionListMembershipReaders {
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

    async getListShareMirrorInfo(config, action_index){
        let root = await this.getListRootIndex(config, action_index);
        try {
            let rows = await this.doQuery(config, `SELECT
                            home_chain,
                            home_list_index
                        FROM list_share_mirrors
                        WHERE action_index=?`, [root]);
            if(!rows || !rows.length) return null;
            let home_chain      = rows[0].home_chain;
            let home_list_index = Number(rows[0].home_list_index);
            let versions = await this.doQuery(config, `SELECT COUNT(*) AS version
                        FROM bridge_settlements
                        WHERE kind='list'
                            AND src_chain=?
                            AND src_action_index=?`, [home_chain, home_list_index]);
            return {
                home_chain,
                home_list_index,
                version: Number(versions && versions[0] ? versions[0].version : 0)
            };
        } catch(e){
            if(isMissingTableError(e)) return null;
            throw e;
        }
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

    async getListOwnerAddresses(config, action_indexes){
        let roots = await this.getListRootIndexes(config, action_indexes);
        let distinct = [...new Set(Object.values(roots))];
        if(distinct.length == 0) return {};
        let marks = distinct.map(() => '?').join(',');
        let creators = await this.doQuery(config, `SELECT
                        l.action_index AS root,
                        a2.address AS owner
                    FROM
                        lists l
                        INNER JOIN actions a1 ON (a1.action_index=l.action_index)
                        LEFT JOIN index_addresses a2 ON (a2.id=a1.source_id)
                    WHERE l.action_index IN (` + marks + `)`, distinct);
        let ownerByRoot = {};
        for(let row of (creators || [])) ownerByRoot[String(Number(row.root))] = row.owner;
        try {
            let transfers = await this.doQuery(config, `SELECT
                            t.list_action_index AS root,
                            a1.address AS owner
                        FROM
                            list_transfers t
                            INNER JOIN lists l ON (l.action_index=t.action_index)
                            INNER JOIN actions transfer_action ON (transfer_action.action_index=t.action_index)
                            INNER JOIN index_statuses s ON (s.id=l.status_id)
                            LEFT JOIN index_addresses a1 ON (a1.id=t.destination_id)
                        WHERE
                            t.list_action_index IN (` + marks + `)
                            AND transfer_action.action_format=3
                            AND s.status='valid'
                        ORDER BY t.action_index ASC`, distinct);
            for(let row of (transfers || [])) ownerByRoot[String(Number(row.root))] = row.owner;
        } catch(e){
            if(!isMissingTableError(e)) throw e;
        }
        let owners = {};
        for(let key in roots) owners[key] = ownerByRoot[String(roots[key])] || null;
        return owners;
    }

    async getListMetas(config, action_indexes){
        let roots = await this.getListRootIndexes(config, action_indexes);
        let distinct = [...new Set(Object.values(roots))];
        if(distinct.length == 0) return {};
        let rows = [];
        try {
            rows = await this.doQuery(config, `SELECT
                            m.list_action_index AS root,
                            m.action_index,
                            m.name,
                            m.description
                        FROM
                            list_metas m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.list_action_index IN (` + distinct.map(() => '?').join(',') + `)
                            AND s.status='valid'
                        ORDER BY m.action_index ASC`, distinct);
        } catch(e){
            if(!isMissingTableError(e)) throw e;
        }
        let metaByRoot = {};
        for(let row of (rows || [])){
            metaByRoot[String(Number(row.root))] = {
                name: row.name == null ? null : row.name,
                description: row.description == null ? null : row.description
            };
        }
        let metas = {};
        for(let key in roots){
            let meta = metaByRoot[String(roots[key])];
            metas[key] = meta || { name: null, description: null };
        }
        return metas;
    }

    async getListMetaAction(config, action_index){
        try {
            let rows = await this.doQuery(config, `SELECT
                            m.action_index,
                            m.list_action_index,
                            m.name,
                            m.description,
                            l.type,
                            memo.memo,
                            status.status
                        FROM
                            list_metas m
                            LEFT JOIN lists l ON (l.action_index=m.list_action_index)
                            LEFT JOIN index_memos memo ON (memo.id=m.memo_id)
                            LEFT JOIN index_statuses status ON (status.id=m.status_id)
                        WHERE m.action_index=?
                        LIMIT 1`, [action_index]);
            return (rows && rows.length) ? rows[0] : null;
        } catch(e){
            if(isMissingTableError(e)) return null;
            throw e;
        }
    }

    async attachListActionDetail(config, action_index, data){
        let reference = Number(action_index);
        let format = this.util.isNull(data.action_format) ? null : Number(data.action_format);
        if(format === 5){
            let meta = await this.getListMetaAction(config, action_index);
            data.list = [];
            data.edits = [];
            data.type = null;
            data.edit = null;
            data.list_action_index = null;
            data.name = null;
            data.description = null;
            if(meta){
                data.status = meta.status;
                data.memo = meta.memo;
                data.type = this.util.isNull(meta.type) ? null : Number(meta.type);
                data.list_action_index = this.util.isNull(meta.list_action_index)
                    ? null : Number(meta.list_action_index);
                data.name = meta.name == null ? null : meta.name;
                data.description = meta.description == null ? null : meta.description;
                reference = data.list_action_index;
            } else {
                reference = null;
            }
        } else {
            let metas = await this.getListMetas(config, [action_index]);
            let meta = metas[String(Number(action_index))] || { name: null, description: null };
            data.name = meta.name;
            data.description = meta.description;
        }
        if(this.util.isNull(reference)){
            data.state = {
                edit_resolution_active: await this.isListEditResolutionActiveAtTip(config),
                membership_action_index: null,
                current_list: null,
                owner: null,
                share_mirror: null
            };
            return;
        }
        data.state = await this.getListCurrentMembership(config, reference, data.type);
        data.state.share_mirror = await this.getListShareMirrorInfo(config, reference);
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
        return gateRegistry.activeAt(LIST_EDIT_RESOLUTION_KEY, resolved.network, resolved.coin, tip, null);
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
        let owners = await this.getListOwnerAddresses(config, [action_index]);
        let state  = { edit_resolution_active: active, membership_action_index: Number(action_index), current_list: null,
            owner: owners[String(Number(action_index))] || null };
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

const listHandler = require('../../../action-detail').REGISTRY.LIST;
listHandler.afterQueries = async function({ db, config, action_index }, data){
    await db.attachListActionDetail(config, action_index, data);
};
