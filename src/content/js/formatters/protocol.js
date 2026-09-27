/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Protocol presentation helpers for sentinel values, flags, and indexes.
 *********************************************************************/

'use strict';

// Render a numeric zero as the protocol meaning supplied by the caller.
function formatZeroSentinel(value, zeroMeaning){
    if(isNull(value)) return '';
    return Number(value) === 0 ? zeroMeaning : formatAmount(value);
}

// Render binary wire flags as their meaning instead of exposing 0 or 1.
function formatBinaryFlag(value, enabledMeaning, disabledMeaning){
    if(isNull(value)) return '';
    return Number(value) === 1 ? enabledMeaning : disabledMeaning;
}

// Pair a zero-based protocol index with the parent label when it is available.
function formatIndexedLabel(index, label){
    if(isNull(index)) return '-';
    return String(index) + (isNull(label) ? '' : ': ' + String(label));
}

// Render SLEEP sentinels as actions and positive values as block links.
function formatResumeBlock(coin, value){
    if(isNull(value)) return '';
    if(Number(value) === -1) return 'Indefinitely';
    if(Number(value) === 0) return 'Immediately';
    return formatLink('/' + coin + '/block/' + value, formatAmount(value));
}

// The contract page's "Owner Withdraw" cell, from the response's owner_withdraw
// (OWNER_WITHDRAW_OPT_IN): true when the deployer can still WITHDRAW the tokens
// the contract holds, false when tokens leave only through the contract's own
// code, and anything else (an older server, an unresolved network) unknown
// rather than guessed. All markup is ours; nothing author-supplied reaches it.
function formatOwnerWithdraw(value){
    if(value === true)
        return '<span class="badge text-bg-warning">Allowed</span> '
            + '<span class="text-muted small">The deployer can withdraw tokens this contract holds at any time.</span>';
    if(value === false)
        return '<span class="badge text-bg-success">Not allowed</span> '
            + '<span class="text-muted small">Tokens leave only through the contract\'s own logic.</span>';
    return '<span class="text-muted">Unknown</span>';
}

if(typeof module !== 'undefined' && module.exports){
    module.exports = {
        formatZeroSentinel,
        formatBinaryFlag,
        formatIndexedLabel,
        formatResumeBlock,
        formatOwnerWithdraw
    };
}
