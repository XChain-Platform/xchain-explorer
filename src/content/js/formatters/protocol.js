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

if(typeof module !== 'undefined' && module.exports){
    module.exports = {
        formatZeroSentinel,
        formatBinaryFlag,
        formatIndexedLabel,
        formatResumeBlock
    };
}
