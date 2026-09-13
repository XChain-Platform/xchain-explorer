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
 * XChain Explorer - action detail and batch loaders
 *
 * Proposal B stage 4: the I/O behind one action's detail page and behind every
 * page that needs the same thing for many actions at once. The getActionData
 * pipeline and its supplements, the fee, meta, transaction and preload batch
 * loaders that exist to kill N+1 reads, the compact summary projection, the LIST
 * membership resolvers (root, head, current members), the order-offer readers,
 * and the destination attachment that tells a feed who received what.
 *
 * The batch loaders are not an optimisation bolted on beside the single readers:
 * they issue different SQL for the same answer, so they live next to the single
 * reader whose shape they must keep matching. The summary field list is the
 * contract between them and lives in ../shared.js, where db.js can still export it.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const listEditResolution = require('../../list_edit_resolution_activation');
const actionDetail = require('../../action-detail');
const { ACTION_SUMMARY_FIELDS } = require('../shared.js');

// The action families that carry a real RECIPIENT, and the column on each that
// points back at the action (decision I-46, measured against xchain-indexer/src/sql).
// Backs getActionsSince's `destinations` (spec wallet-unconfirmed-and-sounds M1.4).
//
// Two things here are load-bearing and easy to get wrong:
//
//   - `contracts` is DELIBERATELY ABSENT. It carries `slash_destination_id`, not
//     `destination_id`, and that column is DEPLOY-time slash ROUTING CONFIG, not a
//     recipient of anything. Including it would fan "you received something" out to
//     every address a contract merely names in its deploy, which is the opposite of
//     what the wallet's incoming-receipt notification means. It is also the only
//     destination-ish column not named `destination_id`, which is how a naive grep
//     sweeps it back in; do not add it.
//   - Three of the join keys are NOT `action_index`. `slash_events` keys on
//     `execution_index` (FK to contract_executions.action_index) and
//     `capability_slash_events` on `slash_action_index` (FK to actions.action_index).
//     Joining either on `action_index` silently matches nothing, since neither table
//     has that column at all.
//
// `sends.action_index` is a NON-unique index on purpose: a multi-output SEND is
// several rows sharing one action_index, and every one of their destinations must
// reach the wire. That is why the lookup below collects a LIST per action rather
// than a single value.
//
// These table/column names are compile-time literals interpolated as SQL
// IDENTIFIERS (a placeholder cannot bind an identifier). No caller can reach them:
// nothing outside this constant is ever spliced into the query, and every VALUE is
// still bound with `?`.
const ACTION_DESTINATION_FAMILIES = [
    { table: 'sends',                   key: 'action_index'       },
    { table: 'sweeps',                  key: 'action_index'       },
    { table: 'dispenses',               key: 'action_index'       },
    { table: 'mints',                   key: 'action_index'       },
    { table: 'messages',                key: 'action_index'       },
    { table: 'fees',                    key: 'action_index'       },
    { table: 'slash_events',            key: 'execution_index'    },
    { table: 'capability_slash_events', key: 'slash_action_index' }
];

class ActionDetailReaders {
    /******************************************************************
     * Commonly used functions 
     *****************************************************************/

    // Extract the revoke target of a DELEGATE v2/v3 from the transaction's decoded
    // action string. Returns { pubkey } for v2 (capability revoke) and
    // { pubkey, target, tick } for v3 (contract-targeted revoke), or null when the
    // wire is absent/unparseable. Locates the `DELEGATE|<fmt>|...` segment so it works
    // for a standalone DELEGATE and one nested in a BATCH (`VERSION|CMD;CMD`); the
    // 64-hex signing pubkey is a fixed-width token, so the match is unambiguous.
    _parseDelegateRevokeWire(wire, fmt){
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
    async _resolveCoinNetwork(config){
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
    async _isListEditResolutionActiveAtTip(config){
        let resolved = null;
        try {
            resolved = await this._resolveCoinNetwork(config);
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
        let active = await this._isListEditResolutionActiveAtTip(config);
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

    // @param {object} preload  optional page-level prefetch from _buildActionPreload.
    //                          Every leg it carries is OPTIONAL: an
    //                          index or tx_hash it does not cover falls through to
    //                          the single-index query, so the payload is the same
    //                          whether the preload is present, partial, or absent.
    async getActionData(config, action_index, preload){
        // Check LRU cache first. Action data is immutable once confirmed, but a
        // reorg can reassign action_index, so the key carries coin + reorg
        // generation (action_index is per-coin, and a reorg bumps the generation
        // to invalidate; see _cacheKey / bumpReorgGeneration).
        //
        // "Immutable once confirmed" does NOT hold for the responses that carry a
        // live `state` block (DISPENSER, ORDER, SWAP): give_remaining, status,
        // expiration and the allow/block lists are all recomputed from LATER
        // dispenses, matches, edits and closes. Those are not written back here -
        // see the _cacheSet guard at the end of this method - so this lookup only
        // ever returns a genuinely immutable action.
        let cached = this._cacheGet(this._actionDataCache, this._cacheKey(config.coin, action_index));
        if(cached !== undefined) return structuredClone(cached);
        let coinConfigs = await this.configInfo.getConfig()
        let data = {
            credits: null,
            debits:  null,
            escrows: null,
            fee:    null
        };
        // Use the page preload only for the indexes it actually prefetched; anything
        // else runs the per-index queries exactly as before.
        let pre  = (preload && preload.indexes && preload.indexes.has(Number(action_index))) ? preload : null;
        let type = (pre && pre.types.has(Number(action_index)))
            ? pre.types.get(Number(action_index))
            : await this.getActionType(config, action_index);
        if(type){
            // Per-action detail is a registry (src/action-detail/), not an
            // if-chain: one handler per action type owns its SQL and its result
            // shaping, so a new action adds a handler file entry instead of
            // editing the middle of this method. Everything below is
            // the part every action shares - run the detail query, de-blank a
            // row-less variant, run the follow-ups, attach ledger effects - with
            // the handler's hooks called at the points where actions differ.
            let handler = actionDetail.getHandler(type);
            let ctx     = { db: this, config, coinConfigs, action_index, type, util: this.util };
            let built   = (handler.queries) ? await handler.queries(ctx) : {};
            let query   = built.query  || null;
            let query2  = built.query2 || null;
            let query3  = built.query3 || null;
            let results = null;
            if(query){
                results = await this.doQuery(config, query, [action_index]);
                if(results && results.length)
                    data = Object.assign({}, data, results[0]);
            }
            if(!results || !results.length)
                data = await actionDetail.deblankBaseline(this, config, action_index, data);
            if(handler.afterMain)
                await handler.afterMain(ctx, data);
            if(query2){
                // Set correct arguments for the query
                let args2 = (handler.query2Args) ? handler.query2Args(ctx, data) : [action_index];
                results = await this.doQuery(config, query2, args2);
                if(results && results.length && handler.afterQuery2)
                    await handler.afterQuery2(ctx, data, results);
            }
            if(query3){
                let args3 = (handler.query3Args) ? handler.query3Args(ctx, data) : [action_index];
                results = await this.doQuery(config, query3, args3);
                if(results && results.length && handler.afterQuery3)
                    await handler.afterQuery3(ctx, data, results);
            }
            if(handler.afterQueries)
                await handler.afterQueries(ctx, data);
            await this.attachActionDetailSupplements(config, type, action_index, data, pre);
            await actionDetail.attachLedgerEffects(this, config, action_index, data, handler.effects, (pre) ? pre.effects : null);
            if(handler.afterEffects)
                await handler.afterEffects(ctx, data);
            let fee = (pre && pre.fees.has(Number(action_index)))
                ? pre.fees.get(Number(action_index))
                : await this.getActionFeeData(config, action_index);
            if(fee)
                data.fee = fee;
            // The preload is keyed by tx_hash, and data.tx_hash comes from the handler
            // row, which may name a transaction the page-level prefetch never saw (a
            // BATCH child, a handler that aliases another action's tx). A hash the map
            // does not carry falls back to the single-hash query rather than to null.
            let txKey  = this.util.isNull(data.tx_hash) ? null : String(data.tx_hash);
            let txData = (pre && txKey !== null && pre.txs.has(txKey))
                ? pre.txs.get(txKey)
                : await this.getTransactionData(config, data.tx_hash);
            data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
        }
        // Store in LRU cache for future lookups (coin + reorg-generation key, see getActionData entry).
        // Skip anything carrying a live `state` block: DISPENSER, ORDER and SWAP responses
        // derive give_remaining / status / expiration / allow_list / block_list from rows
        // written AFTER the action confirmed, and the cache has no TTL, so a cached entry
        // would freeze that state for the process lifetime (measured on regtest:
        // a fully-drained, closed dispenser kept serving `give_remaining: 200, status: open`
        // until the explorer restarted, letting the wallet's detail page show a buyer an
        // open dispenser they could pay for nothing).
        if(this._isCacheableAction(data))
            this._cacheSet(this._actionDataCache, this._cacheKey(config.coin, action_index), structuredClone(data));
        return data;
    }

    // Wire-carried fields the per-type detail handlers cannot select because they
    // live in a SIBLING event table, not the handler's primary table. The action
    // detail is the page that exists to render what the wire format carried, so a
    // field the indexer stores must appear here, populated on the variant that
    // carries it and present-as-null on the others (the shape every other ISSUE
    // variant field already follows). All three source tables are append-only and
    // reorg rollback deletes their rows, so the values are as cache-safe as the
    // rest of the action payload.
    async attachActionDetailSupplements(config, type, action_index, data, pre){
        let fmt = this.util.isNull(data.action_format) ? null : Number(data.action_format);
        if(type=='ISSUE'){
            // ISSUE v6 = controller bind/unbind (ISSUE|6|TICK|CONTROLLER|ACTION_CLASS|
            // COOLDOWN_BLOCKS|UNBIND). The event row is written to token_controllers,
            // never to `issues`, so without this the four wire fields vanished from
            // the API row while /api/controllers showed them.
            data.controller      = null;
            data.action_class    = null;
            data.cooldown_blocks = null;
            data.unbind          = null;
            if(fmt === 6){
                let rows = await this.doQuery(config,
                    `SELECT
                        c.contract_index as controller,
                        c.action_class,
                        c.cooldown_blocks,
                        c.is_unbind as unbind
                    FROM
                        token_controllers c
                    WHERE
                        c.action_index=?
                    LIMIT 1`, [action_index]);
                // No row = the bind/unbind never applied (invalid action, or rolled
                // back); the keys stay null rather than being reparsed from tx_data.
                if(rows && rows.length)
                    Object.assign(data, rows[0]);
            }
        }
        if(type=='DEPLOY' && fmt === 4){
            // v4 chunk carrier: CODE_PART is a first-class wire field and this page
            // is the only surface that can show the payload. The full slice rides
            // the single-action row only; list rows carry code_part_length instead
            // (getDeployChunks), because a MEDIUMTEXT slice per row is too heavy for
            // a paged list.
            data.code_part        = null;
            data.code_part_length = null;
            let rows = await this.doQuery(config,
                `SELECT
                    m.code_part,
                    CHAR_LENGTH(m.code_part) as code_part_length
                FROM
                    deploy_chunks m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
            if(rows && rows.length){
                data.code_part        = rows[0].code_part;
                data.code_part_length = this.util.isNull(rows[0].code_part_length) ? null : Number(rows[0].code_part_length);
            }
        }
        // A v4 carrier is normally a code slice and nothing else, but the piece that
        // COMPLETES a chunked group runs the deployment at its own action_index, so
        // the constructor was billed here and its execution row sits at this index
        // too. The detail handler's own probe has already answered whether a
        // contracts row exists here (deployed_contract_index, set in afterMain,
        // which runs before this method), so this reuses that answer rather than
        // asking again: an ordinary carrier that completed nothing still issues no
        // contract_executions query at all.
        let carrierDeployed = (fmt === 4 && !this.util.isNull(data.deployed_contract_index));
        if(type=='DEPLOY' && fmt !== null && (fmt !== 4 || carrierDeployed)){
            // v0-v3 deploy, and the completing v4 carrier: the constructor run is
            // billed like any EXECUTE and the indexer records it in
            // contract_executions, but the detail row showed no gas at all, hiding
            // the deployer's cost. Surface the recorded gas plus the execution
            // linkage (contract_index / method_name); this reads existing execution
            // rows only and invents no fee artifacts.
            data.contract_index = null;
            data.method_name    = null;
            data.gas_used       = null;
            data.gas_limit      = null;
            let rows = await this.doQuery(config,
                `SELECT
                    m.contract_index,
                    m.method_name,
                    m.gas_used,
                    m.gas_limit
                FROM
                    contract_executions m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
            if(rows && rows.length)
                Object.assign(data, rows[0]);
        }
        // Emission provenance, for EVERY action type. A VM-emitted action has no wire string
        // of its own - it was never on the wire - so `tx_data` on its detail row is the PARENT
        // EXECUTE's string. Read alone on a per-action page that says "Transaction Data", it
        // reads as this action's own data, and it is the field this campaign cross-checks
        // rendered values against. No synthetic string is composed here: inventing a wire form
        // that was never broadcast would be worse than the ambiguity. Instead the page is told
        // where the action came from, so it can label the parent's string as the parent's.
        // A page-level prefetch resolves this leg for the whole index set at once; asking
        // per-action here put the page back above the per-index query ceiling that
        // action-preload-parity guards. The single-index path falls through to the batch
        // helper with a set of one, so both paths return the identical shape.
        data.emitted_by = null;
        let key = Number(action_index);
        if(pre && pre.emitted && pre.indexes && pre.indexes.has(key)){
            data.emitted_by = pre.emitted.has(key) ? pre.emitted.get(key) : null;
        } else {
            let one = await this.getEmissionProvenanceBatch(config, [key]);
            data.emitted_by = one.has(key) ? one.get(key) : null;
        }
    }

    // Get fee information for a given action_index
    async getActionFeeData(config, action_index){
        let fee   = null;
        let args  = [action_index];
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }
    async getActionType(config, action_index){
        let type = null;
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        LEFT  JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(config, sql, args);
        if(results && results.length)
            type = results[0].action;
        return type;
    }

    // Supports search types: 'block', 'address', 'token', 'recent'.
    async getHistoryData(config){
        let sql       = config.data.sql;
        let type      = config.data.type;
        let q         = config.data.query;
        let offset    = (config.data.offset) ? config.data.offset : false;
        let action    = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start     = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? offset.start : false;
        let limit     = sql.limit;
        let total     = 0;
        let id        = 0;
        let history   = [];
        let args      = [];
        let results   = null;
        let count     = null;
        let query     = null;
        let where     = sql.where.data;
        // WHICH TABLE THE FEED IS DRIVEN BY, and why it is not always mappings_actions.
        //
        // mappings_actions is an address/tick LOOKUP INDEX, not an action list: the
        // indexer writes it from the addresses/tickers an action touched
        // (xchain-indexer src/chain/mapper.js, fed by util.getAddressesList(), which is only
        // populated by credit/debit bookkeeping). An action that moves no ledger entry
        // - ANCHOR, PRICE, ATTEST, NODEPROOF, ROLLCALL and every future consensus
        // action - therefore has NO row there and is structurally unreachable through
        // it. Driving the unfiltered feed off that table did not merely under-report:
        // on a network whose actions are all consensus actions (a fresh testnet
        // publishing PRICE rounds and ANCHOR checkpoints) it answered an empty
        // "All Activity" list and an empty per-block action list while the actions
        // existed and their own /anchors and /prices pages listed them.
        //
        // So the mapping table is used ONLY where its lookup is what the query needs
        // (type=address / type=token, which filter on m.type_id + m.id); the
        // all-activity and per-block feeds read `actions` directly. `cursor` is the
        // paging column for whichever shape is in play, and getQueryWhereSql anchors
        // its WHERE on the matching alias.
        let mapped    = ['address','token'].includes(type);
        let cursor    = (mapped) ? 'm.action_index' : 'a1.action_index';
        let source    = (mapped)
            ? `mappings_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)`
            : `actions a1`;
        if(type=='address')
            id = await this.getAddressId(config, config.data.search);
        if(type=='token')
            id = await this.getTickId(config, config.data.search);
        // For full-history (search='null'): pre-set total to the highest action_index to avoid a COUNT(*) scan.
        if(config.data.search=='null'){
            let query = `SELECT
                            action_index
                        FROM
                            actions
                        ORDER BY action_index DESC
                        LIMIT 1`;
            results = await this.doQuery(config, query);
            if(results && results.length)
                q.total = Number(results[0].action_index);
        }
        // Seed bind args to match the WHERE built by getQueryWhereSql: address/token add
        // 'm.id=?' (the resolved id), block adds 'b1.block_index=?'. type=recent (the
        // homepage default) and null add no placeholder, so any seed here is a phantom that
        // shifts the offset 'action_index < ?' bind (binding 0 -> 'action_index < 0' -> no rows).
        args = (type=='block') ? [config.data.search]
             : (['address','token'].includes(type) ? [id] : []);
        // Skip COUNT query when total is passed on the querystring (speeds up explorer pagination).
        // Number() because a querystring value arrives as a string and `total` is the
        // shared list-envelope field, which every other list route emits as a JSON
        // integer (see the count branch of the generic list path); history was the one
        // route handing consumers a string for it.
        if(q && q.total){
            total = Number(q.total);
        } else {
            // Get total number of matching records for this type of action and add to grand total
            count = `SELECT
                        count(DISTINCT(` + cursor + `)) as count
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
            results = await this.doQuery(config, count, args);
            if(results && results.length)
                // bcadd returns a decimal STRING (mathjs bignumber formatting), which is
                // what put a quoted total on the history envelope; a row count is a plain
                // integer far below 2^53, so narrow it here.
                total = Number(this.util.bcadd(total, results[0].count, 0));
        }
        if(action && start){
            if(action=='prev'){
                where += ' AND ' + cursor + ' > ?';
                args.push(start);
            } else {
                where += ' AND ' + cursor + ' < ?';
                args.push(start);
            }
        }
        // parent_batch_action_index (spec explorer-coverage-completion M1.6):
        // the indexer stores no parent column (batches is (action_index, status_id);
        // every sub-command is its own root action), so parenthood is DERIVED here.
        // A parent and its children share (tx_index, tx_vout) on `actions`; the parent
        // is whichever of those rows also has an `actions.action_index` present in
        // `batches`. This MUST stay a correlated scalar subquery in the select list,
        // never a FROM-clause join: the outer query is SELECT DISTINCT over the whole
        // row, and a join that multi-matches (one BATCH parent joined against N
        // children sharing its tx_vout) would re-materialize duplicate action_index
        // rows past the DISTINCT. A subquery returns exactly one scalar per outer row
        // and does not change row cardinality, so DISTINCT still collapses correctly.
        // `apx.action_index!=a1.action_index` is what makes the parent BATCH row's own
        // value NULL (it would otherwise find itself); every non-batch row also comes
        // back NULL because no sibling row in `batches` exists at all. EXPLAIN shape:
        // apx is looked up via actions' own PK/unique index on action_index bounded by
        // the outer row's tx_index/tx_vout (actions carries a plain index on tx_index,
        // narrowing the scan to the handful of rows sharing one tx output), then
        // filtered through batches' UNIQUE KEY on action_index (an eq_ref, not a scan);
        // the whole subquery runs once per returned row, so cost scales with page size
        // (sql.limit), not table size.
        if(total){
            query = `SELECT
                        DISTINCT(` + cursor + `) as action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        (
                            SELECT bpx.action_index
                            FROM actions apx
                            INNER JOIN batches bpx ON (bpx.action_index=apx.action_index)
                            WHERE apx.tx_index=a1.tx_index
                                AND apx.tx_vout=a1.tx_vout
                                AND apx.action_index!=a1.action_index
                            LIMIT 1
                        ) as parent_batch_action_index
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY ` + cursor + ` ` + sql.order + `
                    LIMIT ` + sql.limit;
            results = await this.doQuery(config, query, args);
            if(results && results.length){
                for(let row of results)
                    history.push(row);
            }
        }
        // Get summary data for actions
        let data = await this.getActionSummaryData(config, history);
        return [data, total];
    }

    // Action type + owning transaction hash for a SET of action_indexes.
    // Mirrors getActionType's join and adds the transactions / index_transactions hop
    // getTransactionData keys on, so one query gives a page both the type it dispatches
    // the handler on and the tx_hash it prefetches transactions by.
    // Returns a Map of action_index -> { type, tx_hash }; an index with no row is absent,
    // which the caller reads the same way getActionType reads a row-less result (null).
    async getActionMetaBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph  = action_indexes.map(() => '?').join(',');
        let sql = `SELECT
                        a1.action_index,
                        a2.action,
                        t2.hash as tx_hash
                    FROM
                        actions a1
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        a1.action_index IN (${ph})`;
        let results = await this.doQuery(config, sql, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row.action_index);
            // First row wins, matching getActionType's unqualified results[0].
            if(map.has(key)) continue;
            map.set(key, {
                type:    (row.action === undefined)  ? null : row.action,
                tx_hash: (row.tx_hash === undefined) ? null : row.tx_hash
            });
        }
        return map;
    }

    // Batched getActionFeeData. Same SELECT list, same order, same joins;
    // action_index rides along last and is deleted, so a surviving row is key-for-key
    // what the single-index query returns. Returns a Map of action_index -> fee row.
    async getActionFeeDataBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph    = action_indexes.map(() => '?').join(',');
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version,
                        f1.action_index as _group_index
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE
                        f1.action_index IN (${ph})`;
        let results = await this.doQuery(config, query, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row._group_index);
            delete row._group_index;
            // First row wins, matching getActionFeeData's unqualified results[0].
            if(!map.has(key)) map.set(key, row);
        }
        return map;
    }

    // Batched getTransactionData, keyed by tx_hash rather than action_index
    // because that is what the single-hash query takes. Every REQUESTED hash gets an
    // entry (null when the row is absent), so a caller can treat map.has() as authority
    // and only fall back for a hash the page never prefetched.
    async getTransactionDataBatch(config, hashes){
        let map = new Map();
        if(!hashes || !hashes.length) return map;
        let distinct = [...new Set(hashes.map((h) => String(h)))];
        let ph       = distinct.map(() => '?').join(',');
        let query = `SELECT
                        t1.tx_index,
                        t1.block_index,
                        t2.hash,
                        t1.fee,
                        t1.data
                    FROM
                        transactions t1
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        t2.hash IN (${ph})`;
        let results = await this.doQuery(config, query, distinct);
        for(let row of (results || [])){
            let key = String(row.hash);
            if(!map.has(key)) map.set(key, row);
        }
        for(let h of distinct)
            if(!map.has(h)) map.set(h, null);
        return map;
    }

    // Build the page-level preload getActionData reads its shared legs from.
    // Six queries for the whole page in place of six per action: one meta query for type
    // and tx_hash, up to three ledger-effect queries, one fee query, one transaction
    // query. The effect prefetch is narrowed by each index's handler `effects` flags,
    // the SAME flags attachLedgerEffects gates on, so the prefetched set and the consumed
    // set are equal by construction and a page of non-ledger actions queries none of them.
    // Per-handler detail queries are deliberately untouched: they differ per action type
    // and batching them is the high-risk half of this change.
    async _buildActionPreload(config, action_indexes){
        let idxs = (action_indexes || []).map((i) => Number(i));
        if(!idxs.length) return null;
        let preload = {
            indexes:  new Set(idxs),
            types:    new Map(),
            fees:     new Map(),
            txs:      new Map(),
            emitted:  new Map(),
            effects:  null
        };
        let meta          = await this.getActionMetaBatch(config, idxs);
        let effectIndexes = { credits: [], debits: [], escrows: [] };
        let typed         = [];
        let hashes        = [];
        for(let idx of idxs){
            let row = meta.get(idx) || { type: null, tx_hash: null };
            preload.types.set(idx, row.type);
            // An untyped index short-circuits in getActionData before any shared leg
            // runs, so it contributes nothing to the effect / fee / tx prefetch sets.
            if(this.util.isNull(row.type)) continue;
            typed.push(idx);
            let flags = actionDetail.getHandler(row.type).effects || {};
            for(let key of ['credits', 'debits', 'escrows'])
                if(flags[key] !== false) effectIndexes[key].push(idx);
            if(!this.util.isNull(row.tx_hash)) hashes.push(String(row.tx_hash));
        }
        preload.effects = await actionDetail.prefetchLedgerEffects(this, config, effectIndexes);
        let fees = await this.getActionFeeDataBatch(config, typed);
        // Absence in the fee query means "no fee row", which is the null the single-index
        // path returns; record it explicitly so has() is authoritative for typed indexes.
        for(let idx of typed)
            preload.fees.set(idx, fees.has(idx) ? fees.get(idx) : null);
        preload.txs = await this.getTransactionDataBatch(config, hashes);
        // Emission provenance is a shared leg like the fee and tx legs: identical in shape
        // for every action, so it runs ONCE over the page instead of once per action.
        // Asking per-action put the page's per-index query count back above the ceiling
        // action-preload-parity guards.
        preload.emitted = await this.getEmissionProvenanceBatch(config, typed);
        return preload;
    }

    // Emission provenance for a SET of action indexes, in two queries rather than two per
    // action. Almost no action is an emission, so the second query runs only for the few
    // that are - and on a page with none it does not run at all. Returns a Map of
    // action_index -> { execution_index, position, contract_index, caller }, containing only
    // the indexes that ARE emissions; absence means "broadcast normally".
    async getEmissionProvenanceBatch(config, action_indexes){
        let out  = new Map();
        let idxs = (action_indexes || []).map((i) => Number(i)).filter((i) => !isNaN(i));
        if(!idxs.length) return out;
        let holes = idxs.map(() => '?').join(',');
        let rows  = await this.doQuery(config,
            `SELECT
                e.action_index,
                e.execution_index,
                e.position
            FROM
                contract_emissions e
            WHERE
                e.action_index IN (${holes})`, idxs);
        if(!rows || !rows.length) return out;
        for(let r of rows)
            out.set(Number(r.action_index), {
                execution_index: r.execution_index,
                position:        r.position,
                contract_index:  null,
                caller:          null
            });
        let parents = [...new Set([...out.values()].map((v) => Number(v.execution_index)))];
        let pHoles  = parents.map(() => '?').join(',');
        let pRows   = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.contract_index,
                a1.address as caller
            FROM
                contract_executions m
                LEFT  JOIN index_addresses a1 ON (a1.id=m.caller_id)
            WHERE
                m.action_index IN (${pHoles})`, parents);
        let byExec = new Map((pRows || []).map((r) => [Number(r.action_index), r]));
        for(let v of out.values()){
            let p = byExec.get(Number(v.execution_index));
            if(p){ v.contract_index = p.contract_index; v.caller = p.caller; }
        }
        return out;
    }

    // Batch-load getActionData for a set of action indexes (Fix B / #3841). Resolves the
    // DISTINCT action_index set concurrently through the existing getActionData path (bounded
    // by BATCH_CONCURRENCY so the connection pool is not exhausted), returning a Map keyed by
    // the numeric action_index. Because each entry is produced by the unmodified getActionData,
    // every payload is byte-for-byte identical to the per-row path it replaces; the only change
    // is that the page's lookups now overlap instead of running strictly serially, and the LRU
    // _actionDataCache is warmed exactly as before. Callers must read results by action_index
    // (never rely on ordering). Failures propagate unchanged (same as the old per-row await).
    async getActionDataBatch(config, actionIndexes){
        const BATCH_CONCURRENCY = Number(this.config && this.config.BATCH_CONCURRENCY) || 8;
        // Distinct, insertion-order-preserving set of indexes to fetch.
        let distinct = [];
        let seen = new Set();
        for(let idx of actionIndexes){
            let key = Number(idx);
            if(!seen.has(key)){ seen.add(key); distinct.push(idx); }
        }
        // Shared-leg prefetch. Overlapping the fan-out hid the latency but
        // left the page's DB work at O(actions x queries): every index still ran its
        // own type, three ledger-effect, fee and transaction queries. Those legs are
        // identical in shape for every action, so the page runs each of them ONCE over
        // the whole index set and threads the result in as a preload; only the
        // per-handler detail queries still fan out. Indexes already in the LRU are
        // excluded, so a warm page prefetches nothing, and at a single cold index the
        // query count is unchanged (the type and tx legs merge into one meta query).
        let cold = distinct.filter((idx) => this._cacheGet(this._actionDataCache, this._cacheKey(config.coin, idx)) === undefined);
        let preload = (cold.length) ? await this._buildActionPreload(config, cold) : null;
        let out = new Map();
        let cursor = 0;
        const worker = async () => {
            while(cursor < distinct.length){
                let i = cursor++;
                let idx = distinct[i];
                out.set(Number(idx), await this.getActionData(config, idx, preload));
            }
        };
        let workers = [];
        let poolSize = Math.min(BATCH_CONCURRENCY, distinct.length);
        for(let w = 0; w < poolSize; w++) workers.push(worker());
        await Promise.all(workers);
        return out;
    }

    // Project one full getActionData payload onto the compact summary shape the
    // client's getActionDetails renders: ACTION_SUMMARY_FIELDS copied onto a
    // `details` object (false when none is present) plus the row status. SEND
    // keeps its fields per destination under sends[], so the summary reads
    // sends[0] for every field and takes its status when the payload has none.
    // The transaction/history rows and the BATCH member table both go through
    // here, so a field lands on every summary surface at once.
    projectActionSummary(info){
        let details = false;
        let status  = info.status;
        let send    = (info.action=='SEND' && Array.isArray(info.sends) && info.sends.length>0) ? info.sends[0] : null;
        if(send && this.util.isNull(status))
            status = send.status;
        for(let name of ACTION_SUMMARY_FIELDS){
            let found  = false;
            let detail = false;
            if(typeof info[name] !== 'undefined'){
                found  = true;
                detail = info[name];
            }
            if(send){
                found  = true;
                detail = send[name];
            }
            if(found){
                if(!details)
                    details = {};
                details[name] = detail;
            }
        }
        return { details, status };
    }

    async getActionSummaryData(config, actions){
        // --- Performance note (Fix B / #3841) ---
        // The page's action rows are enriched via getActionDataBatch(), which resolves the
        // distinct action_index set through getActionData with bounded concurrency instead of
        // one strictly-serial await per row. Payloads are byte-identical to the old per-row
        // path (same getActionData); only the round-trips now overlap, so first-load latency
        // no longer scales linearly with the serial round-trip count. Tracked as #3841.
        const t0 = Date.now();
        // --- End Fix B ---
        // Pre-resolve every row's action data once, keyed by action_index.
        let actionData = await this.getActionDataBatch(config, actions.map((a) => a.action_index));
        for(let data of actions){
            let info = actionData.get(Number(data.action_index));
            let { details, status } = this.projectActionSummary(info);
            data.status  = status;
            data.details = details;
        }
        // Slow-page observability (Fix B): warn when first-load latency is still high after
        // the batched concurrent fetch (#3841), so any residual slow path stays visible.
        const elapsed = Date.now() - t0;
        if(elapsed > 500)
            console.warn('getActionSummaryData: slow page (' + elapsed + 'ms, ' + actions.length + ' actions) -- batched getActionData fetch still slow; see #3841');
        return actions;
    }

    async getSearch(config){
        // --- Performance guard (Fix A) ---
        // Every search term is wrapped in leading+trailing % which defeats all B-tree indexes,
        // causing full-table scans across every search column. Short terms (e.g. 1-2 chars)
        // are especially costly because they can match a huge fraction of every table.
        // The proper long-term fix is a FULLTEXT index on the searched columns, or a
        // normalized lowercase prefix column with a covering index -- tracked post-launch.
        // Until then: reject terms below the minimum length to cap scan cost.
        const SEARCH_MIN_LENGTH = 3;
        const searchRaw = (config.data.search || '').trim();
        if(searchRaw.length < SEARCH_MIN_LENGTH){
            return [{ data: [], totals: { addresses: 0, broadcasts: 0, contracts: 0, tokens: 0, transactions: 0 } }, null, 0];
        }
        // Cap the result LIMIT to a safe ceiling regardless of what the pager computed,
        // as a defense-in-depth measure against runaway scans on popular terms.
        const SEARCH_MAX_ROWS = 100;
        // --- End Fix A ---
        let searchTypes = ['address', 'broadcast', 'contract', 'token', 'transaction'];
        let dataType    = config.data.type;
        let search      = '%' + this.util.escapeLike(searchRaw) + '%';
        let total       = 0;
        let sql  = config.data.sql;
        const searchLimit = Math.min(Number(sql.limit) || SEARCH_MAX_ROWS, SEARCH_MAX_ROWS);
        // The contract panel is the ONE panel that is not a LIKE (spec 2.6): contracts
        // carry a FULLTEXT index over (meta_name, meta_description), so a name or
        // description word is matched through it rather than by a leading-% scan. Its
        // term is sanitized for BOOLEAN MODE and can come back empty (a term of nothing
        // but operator characters), which leaves the contract panel at zero while the
        // other four still answer their own counts.
        let ftTerm = this.fulltextTerm(searchRaw);
        let data = {
            data: [],
            totals: {
                addresses:    0,
                broadcasts:   0,
                contracts:    0,
                tokens:       0,
                transactions: 0
            },
        };
        let countQueries = [
            { type: 'address',     query: `SELECT COUNT(*) AS count FROM index_addresses WHERE LOWER(address) LIKE LOWER( ? )`, args: [search] },
            { type: 'transaction', query: `SELECT COUNT(*) AS count FROM transactions t1 LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id) WHERE LOWER(t2.hash) LIKE LOWER( ? )`, args: [search] },
            { type: 'broadcast',   query: `SELECT COUNT(*) AS count FROM broadcasts b LEFT JOIN index_memos m ON (m.id=b.memo_id) WHERE LOWER(b.message) LIKE LOWER( ? ) OR LOWER(m.memo) LIKE LOWER( ? )`, args: [search, search] },
            { type: 'token',       query: `SELECT COUNT(*) AS count FROM tokens t1 LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) WHERE LOWER(t2.tick) LIKE LOWER( ? ) OR LOWER(t1.description) LIKE LOWER( ? )`, args: [search, search] }
        ];
        if(ftTerm !== '')
            countQueries.push({ type: 'contract', query: `SELECT COUNT(*) AS count FROM contracts m WHERE MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)`, args: [ftTerm] });
        let countResults = await Promise.all(countQueries.map(q => this.doQuery(config, q.query, q.args)));
        for(let i = 0; i < countQueries.length; i++){
            let results = countResults[i];
            let type    = countQueries[i].type;
            if(results && results.length){
                let cnt = Number(results[0].count);
                if(type=='address')     data.totals.addresses    = cnt;
                if(type=='broadcast')   data.totals.broadcasts   = cnt;
                if(type=='contract')    data.totals.contracts    = cnt;
                if(type=='token')       data.totals.tokens       = cnt;
                if(type=='transaction') data.totals.transactions = cnt;
                if(type==dataType)      total = cnt;
            }
        }
        if(total){
            let query = false;
            let args  = [search];
            if(['broadcast','token'].includes(dataType))
                args.push(search);
            // The contract panel binds the FULLTEXT term, not the LIKE pattern.
            if(dataType=='contract')
                args = [ftTerm];
            if(dataType=='address')
                query = `SELECT
                            address
                        FROM
                            index_addresses
                        WHERE
                            LOWER(address) LIKE LOWER( ? )
                        ORDER BY address ASC
                        LIMIT ` + searchLimit;
            if(dataType=='transaction')
                query = `SELECT
                            t2.hash
                        FROM
                            transactions t1
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            LOWER(t2.hash) LIKE LOWER( ? )
                        ORDER BY t2.hash ASC
                        LIMIT ` + searchLimit;
            if(dataType=='broadcast')
                query = `SELECT
                            b.message,
                            m.memo,
                            b.action_index,
                            s.status
                        FROM
                            broadcasts b
                            LEFT  JOIN index_memos    m ON (m.id=b.memo_id)
                            LEFT  JOIN index_statuses s ON (s.id=b.status_id)
                        WHERE
                            LOWER(b.message) LIKE LOWER( ? ) OR
                            LOWER(m.memo)    LIKE LOWER( ? )
                        ORDER BY b.action_index DESC
                        LIMIT ` + searchLimit;
            if(dataType=='token'){
                query = `SELECT
                            t2.tick,
                            t1.description
                        FROM
                            tokens t1
                            LEFT  JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                        WHERE
                            LOWER(t2.tick)        LIKE LOWER( ? ) OR
                            LOWER(t1.description) LIKE LOWER( ? )
                        ORDER BY t2.tick ASC
                        LIMIT ` + searchLimit;
            }
            // Contracts, matched through meta_search rather than by LIKE. Newest
            // first: contract indexes are monotonic, so ORDER BY action_index DESC
            // is "most recently deployed", which is what a name search is looking
            // for when several contracts share a name (they are not unique).
            if(dataType=='contract'){
                query = `SELECT
                            m.action_index,
                            m.meta_name,
                            m.meta_version,
                            m.meta_description
                        FROM
                            contracts m
                        WHERE
                            MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)
                        ORDER BY m.action_index DESC
                        LIMIT ` + searchLimit;
            }
            if(query){
                let results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.data = results;
                // A contract hit carries the derived address the reader actually
                // navigates by (C:<CHAIN>:<action_index>, the same derivation
                // getContractBalance uses) and a bounded description snippet: the
                // column holds up to 512 bytes, which is a paragraph in a results row.
                if(dataType=='contract' && Array.isArray(data.data)){
                    let chain = this.baseCoin ? (this.baseCoin[config.coin] || config.coin) : config.coin;
                    data.data = data.data.map((row) => ({
                        action_index:     row.action_index,
                        contract_address: 'C:' + chain + ':' + row.action_index,
                        meta_name:        this.util.isNull(row.meta_name)    ? null : row.meta_name,
                        meta_version:     this.util.isNull(row.meta_version) ? null : row.meta_version,
                        snippet:          this._metaSnippet(row.meta_description)
                    }));
                }
            }
        }
        // Get count of total number of addresses
        return [data, null, total]
    }

    // Return order info for given action_index
    async getOrderInfo(config, action_index){
        let order = false;
        let query = `SELECT 
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM 
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index=? 
                    LIMIT 1`;
        let args  = [action_index];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            order = results[0];
            // Convert BIGINT values to Numbers
            order.action_index = Number(order.action_index);
            order.block_index  = Number(order.block_index);
            order.block_time   = Number(order.block_time);
            order.allow_list   = Number(order.allow_list);
            order.block_list   = Number(order.block_list);
        }
        // Get additional information on this order 
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEditInfo(config, action_index);
            if(edit.expiration) order.expiration = edit.expiration;
            if(edit.allow_list) order.allow_list = edit.allow_list;
            if(edit.block_list) order.block_list = edit.block_list;
            // Determine order get/give prices
            order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
            order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(config, action_index);
            order.give_remaining = give_remaining;
            order.get_remaining  = get_remaining;
        }
        order = this.util.ksort(order);
        return order;
    }

    // Return order edit information for given action_index
    async getOrderEditInfo(config, action_index){
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }    

    async getOrderAmountsRemaining(config, action_index){
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        let query  = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount
                    FROM 
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;  
            give_remaining = info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;  
            get_remaining  = info.get_amount;
        }
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid'];
        results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount);
            }
        }
        return [give_remaining, get_remaining];
    }

    // Render a derived amount as a plain decimal string. mathjs bignumbers
    // stringify to exponential notation below 1e-7 ('3e-8'), which no client
    // parses as an amount, so 18-decimal dust would render unusable.
    _amountString(value){
        if(this.util.isNull(value)) return null;
        return (value && typeof value.toFixed === 'function') ? value.toFixed() : String(value);
    }

    /**
     * Live escrow for one or more dispensers.
     *
     * The ONLY dispenser-escrow derivation in this service. A dispenser holds no
     * escrow column: what is left is the valid create row's GIVE_ESCROW, plus the
     * top-up every valid DISPENSER_EDIT added, minus what every valid DISPENSE
     * paid out. That is consensus-sensitive arithmetic (the indexer's
     * getDispenserAmountRemaining is its mirror, down to the 64-digit precision
     * and the valid-status filters), so both explorer read lanes - the per-action
     * detail path and the getDispensers list path - call this instead of each
     * rolling its own SQL, and the two can never disagree about how full a
     * dispenser is.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) ->
     *                   { give_escrow, escrow_remaining } (both decimal strings,
     *                   give_escrow null for an ownership dispenser, which escrows
     *                   no amount at all)
     */
    async getDispenserEscrowBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        // action_index is a BIGINT that reaches callers as either a Number or a
        // String depending on the driver path, so key on String and de-dupe: a
        // list page can repeat an index and must not bind it twice.
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Opening balance: the create row's escrow. Filtered to valid rows the
        // same way the indexer filters it - an invalid DISPENSER escrows nothing.
        let query = `SELECT
                        d.action_index,
                        d.give_escrow
                    FROM
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE
                        d.action_index IN (` + ph + `) AND
                        s.status=?`;
        let rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let escrow = this.util.isNull(row.give_escrow) ? null : row.give_escrow;
            map[String(row.action_index)] = { give_escrow: escrow, escrow_remaining: escrow };
        }
        // Refills: every valid DISPENSER_EDIT that topped GIVE_ESCROW up.
        query = `SELECT
                    m.dispenser_action_index,
                    m.give_escrow
                FROM
                    dispenser_edits m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
        rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let entry = map[String(row.dispenser_action_index)];
            if(entry && !this.util.isNull(row.give_escrow))
                entry.escrow_remaining = this.util.bcadd(entry.escrow_remaining, row.give_escrow, 64);
        }
        // Payouts: every valid DISPENSE this dispenser served.
        query = `SELECT
                    m.dispenser_action_index,
                    m.give_amount
                FROM
                    dispenses m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
        rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let entry = map[String(row.dispenser_action_index)];
            if(entry && !this.util.isNull(row.give_amount))
                entry.escrow_remaining = this.util.bcsub(entry.escrow_remaining, row.give_amount, 64);
        }
        for(let key of Object.keys(map)){
            map[key].give_escrow      = this._amountString(map[key].give_escrow);
            map[key].escrow_remaining = this._amountString(map[key].escrow_remaining);
        }
        return map;
    }

    /**
     * Latest lifecycle status for one or more dispensers.
     *
     * The dispensers table's own status column is the CREATE action's validity
     * and never moves; the lifecycle (open / cancelling / cancelled / complete /
     * expired) lives in dispenser_statuses, one row per transition, newest row
     * current. The per-action detail path already resolves it via a
     * MAX(action_index) subquery; this is the batched mirror for the
     * getDispensers list lane, so a listing can tell an open dispenser from a
     * cancelled one without a detail fetch per row.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) -> status string;
     *                   a dispenser with no status row (an invalid create
     *                   writes none) is simply absent from the map
     */
    async getDispenserCurrentStatusBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Ordered oldest->newest so the plain overwrite below leaves the newest
        // transition per dispenser in the map - the same "latest row wins" rule
        // as the detail path's MAX(action_index) subquery, without a correlated
        // subquery per listed row.
        let query = `SELECT
                        m.dispenser_action_index,
                        m.action_index,
                        s.status
                    FROM
                        dispenser_statuses m
                        INNER JOIN index_statuses s ON (s.id=m.status_id)
                    WHERE
                        m.dispenser_action_index IN (` + ph + `)
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, idxs);
        for(let row of (rows || []))
            map[String(row.dispenser_action_index)] = row.status;
        return map;
    }

    /******************************************************************
     * Batch query methods (eliminate N+1 patterns)
     *****************************************************************/

    async getOrderInfoBatch(config, action_indexes){
        if(!action_indexes || action_indexes.length === 0) return {};
        let orderMap = {};
        let placeholders = action_indexes.map(() => '?').join(',');

        let query = `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s4.action_index)
                            FROM order_statuses s4
                            WHERE s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index IN (` + placeholders + `)`;
        let results = await this.doQuery(config, query, [...action_indexes]);
        if(results && results.length > 0){
            for(let row of results){
                row.action_index = Number(row.action_index);
                row.block_index  = Number(row.block_index);
                row.block_time   = Number(row.block_time);
                row.allow_list   = Number(row.allow_list);
                row.block_list   = Number(row.block_list);
                orderMap[row.action_index] = row;
            }
        }

        let editQuery = `SELECT
                            o.order_action_index,
                            o.expiration,
                            o.allow_list,
                            o.block_list
                        FROM
                            order_edits o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.order_action_index IN (` + placeholders + `) AND
                            s.status=?
                        ORDER BY o.action_index ASC`;
        let editResults = await this.doQuery(config, editQuery, [...action_indexes, 'valid']);
        if(editResults && editResults.length > 0){
            for(let row of editResults){
                let idx = Number(row.order_action_index);
                if(orderMap[idx]){
                    if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) orderMap[idx].expiration = Number(row.expiration);
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) orderMap[idx].allow_list = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) orderMap[idx].block_list = Number(row.block_list);
                }
            }
        }

        let amtQuery = `SELECT
                            o.action_index,
                            o.give_amount,
                            o.get_amount
                        FROM
                            orders o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.action_index IN (` + placeholders + `) AND
                            s.status=?`;
        let amtResults = await this.doQuery(config, amtQuery, [...action_indexes, 'valid']);
        let remainingMap = {};
        if(amtResults && amtResults.length > 0){
            for(let row of amtResults){
                let idx = Number(row.action_index);
                remainingMap[idx] = { give_remaining: row.give_amount, get_remaining: row.get_amount };
            }
        }

        let matchPlaceholders = action_indexes.map(() => '?').join(',');
        let matchQuery = `SELECT
                            m.give_action_index,
                            m.get_action_index,
                            m.give_amount,
                            m.get_amount
                        FROM
                            order_matches m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            (m.give_action_index IN (` + matchPlaceholders + `) OR m.get_action_index IN (` + matchPlaceholders + `)) AND
                            s.status=?
                        ORDER BY m.action_index ASC`;
        let matchResults = await this.doQuery(config, matchQuery, [...action_indexes, ...action_indexes, 'valid']);
        if(matchResults && matchResults.length > 0){
            for(let row of matchResults){
                for(let idx of action_indexes){
                    if(row.give_action_index == idx || row.get_action_index == idx){
                        if(remainingMap[idx]){
                            let give_amount = (row.get_action_index == idx) ? row.give_amount : row.get_amount;
                            let get_amount  = (row.get_action_index == idx) ? row.get_amount  : row.give_amount;
                            remainingMap[idx].give_remaining = this.util.bcsub(remainingMap[idx].give_remaining, give_amount);
                            remainingMap[idx].get_remaining  = this.util.bcsub(remainingMap[idx].get_remaining,  get_amount);
                        }
                    }
                }
            }
        }

        for(let idx of action_indexes){
            let order = orderMap[idx];
            if(order){
                order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
                order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
                if(remainingMap[idx]){
                    order.give_remaining = remainingMap[idx].give_remaining;
                    order.get_remaining  = remainingMap[idx].get_remaining;
                }
                orderMap[idx] = this.util.ksort(order);
            }
        }
        return orderMap;
    }

    // Fill `destinations: string[]` on every row of a getActionsSince batch, in
    // place. Backs NEW_ACTION's additive destinations field (spec M1.4): the feed
    // has never selected a destination column, so the Broadcaster's destination
    // routing branch has been permanently inert and the wallet's incoming-receipt
    // notification has never fired for anyone.
    //
    // SHAPE: ONE round trip for the whole batch, a UNION ALL over the eight
    // destination-bearing families (ACTION_DESTINATION_FAMILIES) filtered by the
    // action_index values ACTUALLY FETCHED. This feed drives the 5s ChangeDetector
    // poll, so a per-row lookup would cost up to `limit` (100) round trips every
    // five seconds per coin; a per-family lookup would cost eight. The IN list is
    // built from the fetched rows rather than from the cursor range, so a catch-up
    // burst binds exactly as many parameters as it has actions (<= limit * 8), and
    // an EMPTY batch issues no query at all.
    //
    // FAILURE MODE, deliberately soft: a failed lookup degrades every row to
    // `destinations: []` and the actions still ship. There is scar tissue here. A
    // prior `s1.id=a1.status_id` join against a column that does not exist threw
    // ER_BAD_FIELD_ERROR and SILENTLY killed the entire WebSocket action feed,
    // because getActionsSince returned [] every poll while the detector's cursor
    // kept advancing past the actions nobody ever saw (see the note on the query
    // above). An enrichment must never be able to do that again: destinations are a
    // nice-to-have on a frame whose delivery is not.
    //
    // Every row is given the key unconditionally and up front, so a subscriber
    // never has to tell "no destinations" from "the lookup failed" from "the field
    // is missing": all three are `[]`.
    async _attachActionDestinations(config, rows){
        let indexes = [];
        for(let row of rows){
            row.destinations = [];
            if(!this.util.isNull(row.action_index)) indexes.push(row.action_index);
        }
        if(!indexes.length) return rows;

        let map = await this._getActionDestinationMap(config, indexes);
        for(let row of rows){
            let list = map.get(String(row.action_index));
            if(list) row.destinations = list;
        }
        return rows;
    }

    // action_index (as a decimal string) -> ordered, DEDUPED list of destination
    // addresses, for the given batch of action indexes. Returns an EMPTY map, never
    // throws: every caller treats "no destinations" and "lookup broke" identically.
    async _getActionDestinationMap(config, indexes){
        // Lazily initialized (not in the constructor) because the unit harness
        // builds a Database with Object.create(Database.prototype) and never runs it.
        if(!this._actionDestinationSkip) this._actionDestinationSkip = new Map();
        let skip     = this._actionDestinationSkip.get(config.coin) || new Set();
        let families = ACTION_DESTINATION_FAMILIES.filter(f => !skip.has(f.table));
        let map      = new Map();
        if(!families.length) return map;

        try {
            let [query, args] = this._actionDestinationSql(families, indexes);
            this._collectActionDestinations(map, await this.doQuery(config, query, args));
            return map;
        } catch(e){
            // The union is all-or-nothing: one absent table (an older deployment
            // without capability_slash_events, say) loses the destinations of all
            // eight families. Retry family by family so the rest still resolve, and
            // QUARANTINE only the ones that fail for a schema reason, so the steady
            // state on such a deployment is back to one query per poll rather than
            // nine. A transient failure (connection lost) is deliberately NOT
            // quarantined: it would silence destinations permanently for a fault
            // that clears on its own.
            map.clear();
            for(let family of families){
                try {
                    let [q, a] = this._actionDestinationSql([family], indexes);
                    this._collectActionDestinations(map, await this.doQuery(config, q, a));
                } catch(err){
                    if(this._isSchemaShapeError(err)){
                        skip.add(family.table);
                        this._actionDestinationSkip.set(config.coin, skip);
                        console.error('Action destinations: disabling ' + family.table +
                                      ' for ' + config.coin + ' (' + (err && err.message) + ')');
                    }
                }
            }
            return map;
        }
    }

    // Build the UNION ALL (or the single-family retry). INNER JOIN on
    // index_addresses is what drops a NULL destination_id and an id that resolves to
    // nothing, so the result set holds only real, literal addresses.
    _actionDestinationSql(families, indexes){
        let holes = indexes.map(() => '?').join(',');
        let parts = [];
        let args  = [];
        for(let family of families){
            parts.push(`SELECT
                            m.${family.key} as action_index,
                            a1.address as destination
                        FROM
                            ${family.table} m
                            INNER JOIN index_addresses a1 ON (a1.id=m.destination_id)
                        WHERE
                            m.${family.key} IN (${holes})`);
            // Bound as VALUES, and passed through as the driver gave them to us
            // (BIGINT reads back as a BigInt on this pool): re-stringifying them
            // would make MariaDB compare a quoted literal against a BIGINT column as
            // a DOUBLE, the same >2^53 collapse the cursor comment above warns about.
            args.push(...indexes);
        }
        return [parts.join(' UNION ALL '), args];
    }

    // Fold one result set into the map. Deduped per action because the same address
    // can legitimately appear twice (a multi-output SEND paying one address twice,
    // or a fee and a send landing on the same treasury): a subscriber must not be
    // told about it twice, and the Broadcaster must not broadcast to that channel
    // twice. Insertion order is kept so the wire order is stable across polls.
    _collectActionDestinations(map, rows){
        if(!rows || !rows.length) return map;
        for(let row of rows){
            if(!row || this.util.isNull(row.action_index) || this.util.isNull(row.destination)) continue;
            let key  = String(row.action_index);
            let list = map.get(key);
            if(!list){
                list = [];
                map.set(key, list);
            }
            if(!list.includes(row.destination)) list.push(row.destination);
        }
        return map;
    }

    // "That table or column does not exist here", seen through doQuery's wrapper.
    // doQuery rethrows as DbQueryError with its OWN code ('DB_ERROR') and the
    // driver's SqlError on .cause, so testing the top-level error alone never
    // matches a real one; walk the (short, bounded) cause chain. Mirrors
    // ChangeDetector._isMissingTableError, widened to the bad-column case because
    // that is the exact error class that killed this feed once already.
    _isSchemaShapeError(err){
        for(let e = err, depth = 0; e && depth < 5; e = e.cause, depth++){
            if(e.code === 'ER_NO_SUCH_TABLE'   || Number(e.errno) === 1146) return true;
            if(e.code === 'ER_BAD_FIELD_ERROR' || Number(e.errno) === 1054) return true;
        }
        return false;
    }
}

module.exports = ActionDetailReaders.prototype;
