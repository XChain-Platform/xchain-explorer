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
 * XChain Explorer - one explorer row
 *
 * An explorer list page draws a row as an array of cells in column order, so every
 * method has a branch turning the database row into its own array. The branches
 * live in list_rows.js and feed_rows.js; what is here is the per-row state they
 * all read from, worked out once before the branches run.
 *
 * The steps chain in the order the branches ran inline, and a row falls through
 * every step whose method is not this request's, exactly as it fell through every
 * unmatched `if` before.
 *
 ********************************************************************/

'use strict';

const { chainAndBalanceRows, tokenAndTradeRows, contractAndStakeRows, stakeLifecycleRows } = require('./list_rows.js');
const { voteAndBetRows, crossChainRows, mirrorAndExpiryRows, cancelEditAndGovernanceRows, hubOperationalAndSearchRows } = require('./feed_rows.js');

/**
 * The token lock flags this row carries, or false where the page has none.
 */
function rowLockFlags(info, method){
    // The token's lock flags, packed into one pipe-joined string.
    let locks = false;
    if(['getIssues','getTokens','getProjectTokens'].includes(method)){
        let arr = [
            info.lock_max_supply,
            info.lock_mint,
            info.lock_mint_supply,
            info.lock_max_mint,
            info.lock_description,
            info.lock_sleep,
            info.lock_callback
        ];
        locks = arr.join('|');
    }
    return locks;
}

/**
 * The per-block action counts this row carries, or false where the page has none.
 */
function rowBlockActions(info, method){
    // Per-block action counts, packed into one string rather than sent
    // as a field each, which keeps a block list small on the wire.
    let actions = false;
    if(method=='getBlocks'){
        let arr = [
            info.actions.addresses,
            info.actions.airdrops,
            info.actions.batches,
            info.actions.broadcasts,
            info.actions.callbacks,
            info.actions.destroys,
            info.actions.dispensers,
            info.actions.dispenses,
            info.actions.dividends,
            info.actions.files,
            info.actions.issues,
            info.actions.links,
            info.actions.lists,
            info.actions.messages,
            info.actions.mints,
            info.actions.orders,
            info.actions.order_cancels,
            info.actions.order_edits,
            info.actions.order_matches,
            info.actions.sends,
            info.actions.sleeps,
            info.actions.swaps,
            info.actions.swap_cancels,
            info.actions.swap_edits,
            info.actions.swap_matches,
            info.actions.sweep
        ];
        actions = arr.join('|');
    }
    return actions;
}

/**
 * The per-row state every branch reads: the loop's display counts, the action
 * status, the packed lock and action strings, and the formatted balance figures.
 */
function explorerRowContext(util, info, ctx){
    let status = (info.status=='valid') ? 1 : 0; // 1=valid, 2=invalid
    let percent = 0;                             // Percentage of total supply
    let value   = 0;                             // Estimated value
    let amount  = 0;                             // Amount formatted to correct decimal precision
    let locks   = rowLockFlags(info, ctx.method);
    let actions = rowBlockActions(info, ctx.method);
    // Balance rows carry the amount, its share of total supply, and
    // an estimated value.
    if(['getBalances','getHolders'].includes(ctx.method)){
        // Show the amount at the token's own decimal precision.
        amount  = String(util.bcformat(info.amount, info.decimals));
        percent = String(util.bcmul(util.bcdiv(info.amount,info.supply, 8), 100, 8));
        value   = String(util.bcmul(info.amount, info.coin_price, 8));
    }
    return {
        util, cfg: ctx.cfg, method: ctx.method, count: ctx.count, count_reverse: ctx.count_reverse,
        status, percent, value, amount, locks, actions
    };
}

/**
 * Turn one database row into the array an explorer table draws.
 */
function explorerRow(util, info, ctx){
    let type = ctx.type;
    // Explorer requests return an array of fields in the exact order the
    // table's columns are drawn.
    if(type=='explorer'){
        const c = explorerRowContext(util, info, ctx);
        info = chainAndBalanceRows(info, c);
        info = tokenAndTradeRows(info, c);
        info = contractAndStakeRows(info, c);
        info = stakeLifecycleRows(info, c);
        info = voteAndBetRows(info, c);
        info = crossChainRows(info, c);
        info = mirrorAndExpiryRows(info, c);
        info = cancelEditAndGovernanceRows(info, c);
        info = hubOperationalAndSearchRows(info, c);
    }
    return info;
}

module.exports = { explorerRow };
