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
 * XChain Explorer - per-action detail registry
 *
 * db.getActionData used to be one ~2,600-line if-chain: every action type's
 * SQL and its result shaping sat inline, so adding an action meant editing the
 * middle of the platform's largest method and reviewing it meant reading past
 * 47 unrelated branches . The chain is now a registry: one handler per
 * action type, grouped by family, and getActionData is only the pipeline they
 * share. Adding an action adds a handler; it does not touch db.js.
 *
 * A handler is a plain object. Every hook is optional; a type with no entry at
 * all still renders through getActionData's de-blank fallback.
 *
 *   effects      { credits, debits, escrows } - set a flag false to skip that
 *                ledger-effect query. Default: all three run.
 *   queries(ctx) -> { query, query2, query3 } (may be async)
 *                The detail query and up to two follow-ups. `query` runs first
 *                and its single row is merged into `data`.
 *   afterMain(ctx, data)
 *                Shape the merged row: parse inlined JSON, resolve sub-types,
 *                attach lifecycle rows. Runs before query2/query3.
 *   query2Args(ctx, data) / query3Args(ctx, data) -> args array
 *                Default [action_index].
 *   afterQuery2(ctx, data, rows) / afterQuery3(ctx, data, rows)
 *                Only called when the follow-up returned rows.
 *   afterQueries(ctx, data)
 *                Runs after both follow-ups, before the ledger effects.
 *   afterEffects(ctx, data)
 *                Runs after credits/debits/escrows are attached, for shaping
 *                that needs them.
 *
 * ctx is { db, config, coinConfigs, action_index, type, util }. `db` is the
 * Database instance, so a handler reaches the pool through db.doQuery and
 * reuses db's own helpers rather than opening its own connection.
 *
 ********************************************************************/

'use strict';

const shared = require('./shared.js');

const REGISTRY = Object.assign(
    Object.create(null),
    require('./misc.js'),
    require('./tokens.js'),
    require('./dispensers.js'),
    require('./markets.js'),
    require('./staking.js'),
    require('./contracts.js'),
    require('./consensus.js'),
    require('./governance.js'),
    require('./crosschain.js')
);

// An action type with no handler is not an error: getActionData's de-blank
// fallback still renders its name, block, timestamp and source. Returning a
// shared empty handler keeps that path branch-free.
const NO_HANDLER = Object.freeze({});

function getHandler(type) {
    return REGISTRY[type] || NO_HANDLER;
}

// Sorted so the manifest-conformance guard and the golden generator both see a
// stable order regardless of require order.
const ACTION_TYPES = Object.keys(REGISTRY).sort();

module.exports = {
    REGISTRY,
    ACTION_TYPES,
    getHandler,
    // The two pipeline steps that are the same for every action.
    deblankBaseline:     shared.deblankBaseline,
    attachLedgerEffects: shared.attachLedgerEffects,
    // Page-level form of the effects step (): one query per effect
    // table for a whole index set, feeding attachLedgerEffects' preload arg.
    prefetchLedgerEffects: shared.prefetchLedgerEffects
};
