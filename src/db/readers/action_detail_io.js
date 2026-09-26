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
 * contract between them and lives in ../shared.js, where db/index.js can still export it.
 *
 * The family is split into parts under ./action_detail_io/, and this file
 * composes them:
 *
 *   - lists.js           DELEGATE revoke wire parsing and LIST membership
 *   - action_data.js     the supplements, fee and type legs getActionData runs
 *   - history.js         the history feed and the page-level preload batches
 *   - batches.js         emission provenance and the action summary batch
 *   - search.js          the site search
 *   - orders.js          one order's row, edits and remaining amounts
 *   - order_batches.js   the dispenser and order batch readers
 *   - dispenser_prices.js the current price-source availability for dispensers
 *   - destinations.js    the live feed's destination attachment
 *   - this file          getActionData itself
 *
 * getActionData stays in the entry because it is the pipeline every action type
 * runs through, and the regression that pins it small (test/unit/
 * db_action_detail_registry.test.js) reads this file by name for it.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body per part file and exported as that
 * class's prototype, and composeReaderParts folds those prototypes into the one
 * object exported here, so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/


'use strict';

const actionDetail = require('../../action-detail');
const { composeReaderParts } = require('../reader_parts.js');

// The parts this entry composes. A name two parts both declare throws at require
// time (composeReaderParts), so a method can never be defined in two of them.
const listMethods        = require('./action_detail_io/lists.js');
const actionDataMethods  = require('./action_detail_io/action_data.js');
const historyMethods     = require('./action_detail_io/history.js');
const summaryMethods     = require('./action_detail_io/batches.js');
const searchMethods      = require('./action_detail_io/search.js');
const orderMethods       = require('./action_detail_io/orders.js');
const orderBatchMethods  = require('./action_detail_io/order_batches.js');
const dispenserPrices    = require('./action_detail_io/dispenser_prices.js');
const destinationMethods = require('./action_detail_io/destinations.js');

// Run the handler's own queries for one action: the main row (or the de-blanked
// baseline when it has none), then the optional second and third statements, each
// with the handler's hook after it. Returns the data object, which the main query
// and deblankBaseline both REPLACE rather than mutate.
async function runHandlerQueries(db, config, handler, ctx, built, action_index, data){
    let query   = built.query  || null;
    let query2  = built.query2 || null;
    let query3  = built.query3 || null;
    let results = null;
    if(query){
        results = await db.doQuery(config, query, [action_index]);
        if(results && results.length)
            data = Object.assign({}, data, results[0]);
    }
    if(!results || !results.length)
        data = await actionDetail.deblankBaseline(db, config, action_index, data);
    if(handler.afterMain)
        await handler.afterMain(ctx, data);
    if(query2){
        // Set correct arguments for the query
        let args2 = (handler.query2Args) ? handler.query2Args(ctx, data) : [action_index];
        results = await db.doQuery(config, query2, args2);
        if(results && results.length && handler.afterQuery2)
            await handler.afterQuery2(ctx, data, results);
    }
    if(query3){
        let args3 = (handler.query3Args) ? handler.query3Args(ctx, data) : [action_index];
        results = await db.doQuery(config, query3, args3);
        if(results && results.length && handler.afterQuery3)
            await handler.afterQuery3(ctx, data, results);
    }
    if(handler.afterQueries)
        await handler.afterQueries(ctx, data);
    return data;
}

// The legs every action shares once its handler has run: the sibling-table
// supplements, the ledger effects, the fee row and the transaction wire string.
// Each one takes the page preload where it covers this index and falls through to
// its own single-index query where it does not.
async function attachActionTail(db, config, handler, ctx, type, action_index, data, pre){
    await db.attachActionDetailSupplements(config, type, action_index, data, pre);
    await actionDetail.attachLedgerEffects(db, config, action_index, data, handler.effects, (pre) ? pre.effects : null);
    if(handler.afterEffects)
        await handler.afterEffects(ctx, data);
    let fee = (pre && pre.fees.has(Number(action_index)))
        ? pre.fees.get(Number(action_index))
        : await db.getActionFeeData(config, action_index);
    if(fee)
        data.fee = fee;
    // The preload is keyed by tx_hash, and data.tx_hash comes from the handler
    // row, which may name a transaction the page-level prefetch never saw (a
    // BATCH child, a handler that aliases another action's tx). A hash the map
    // does not carry falls back to the single-hash query rather than to null.
    let txKey  = db.util.isNull(data.tx_hash) ? null : String(data.tx_hash);
    let txData = (pre && txKey !== null && pre.txs.has(txKey))
        ? pre.txs.get(txKey)
        : await db.getTransactionData(config, data.tx_hash);
    data.tx_data = (!db.util.isNull(txData)) ? txData.data : null;
}

class ActionDetailReaders {
    // @param {object} preload  optional page-level prefetch from buildActionPreload.
    //                          Every leg it carries is OPTIONAL: an
    //                          index or tx_hash it does not cover falls through to
    //                          the single-index query, so the payload is the same
    //                          whether the preload is present, partial, or absent.
    async getActionData(config, action_index, preload){
        // Check LRU cache first. Action data is immutable once confirmed, but a
        // reorg can reassign action_index, so the key carries coin + reorg
        // generation (action_index is per-coin, and a reorg bumps the generation
        // to invalidate; see cacheKey / bumpReorgGeneration).
        //
        // "Immutable once confirmed" does NOT hold for the responses that carry a
        // live `state` block (DISPENSER, ORDER, SWAP): give_remaining, status,
        // expiration and the allow/block lists are all recomputed from LATER
        // dispenses, matches, edits and closes. Those are not written back here -
        // see the cacheSet guard at the end of this method - so this lookup only
        // ever returns a genuinely immutable action.
        let cached = this.cacheGet(this._actionDataCache, this.cacheKey(config.coin, action_index));
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
            data = await runHandlerQueries(this, config, handler, ctx, built, action_index, data);
            await attachActionTail(this, config, handler, ctx, type, action_index, data, pre);
        }
        // Store in LRU cache for future lookups (coin + reorg-generation key, see getActionData entry).
        // Skip anything carrying a live `state` block: DISPENSER, ORDER and SWAP responses
        // derive give_remaining / status / expiration / allow_list / block_list from rows
        // written AFTER the action confirmed, and the cache has no TTL, so a cached entry
        // would freeze that state for the process lifetime (measured on regtest:
        // a fully-drained, closed dispenser kept serving `give_remaining: 200, status: open`
        // until the explorer restarted, letting the wallet's detail page show a buyer an
        // open dispenser they could pay for nothing).
        if(this.isCacheableAction(data))
            this.cacheSet(this._actionDataCache, this.cacheKey(config.coin, action_index), structuredClone(data));
        return data;
    }
}

module.exports = composeReaderParts(
    ActionDetailReaders.prototype,
    listMethods,
    actionDataMethods,
    historyMethods,
    summaryMethods,
    searchMethods,
    orderMethods,
    orderBatchMethods,
    dispenserPrices,
    destinationMethods
);
