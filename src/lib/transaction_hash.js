'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Transaction identifiers accepted by explorer reads. Coin transaction
 * hashes are 32-byte hexadecimal values. The indexer also persists fixed-width
 * synthetic identifiers for deterministic genesis and settlement actions.
 */

const HEX_TRANSACTION_HASH_RE = /^[0-9a-f]{64}$/i;
const SYNTHETIC_TRANSACTION_HASH_RE = /^(?:GENESIS-[A-Z]+-(?:P[12]|A|GAS)-[0-9a-f]{48}|XPOLICY-[0-9a-f]{48}|XBRIDGE-[A-Z]+-(?:GAS|BRIDGE|BRIDGEDEC)-[0-9a-f]{48}|LIST_SHARE-[0-9a-f]{48})$/;

/**
 * Return the database lookup spelling for a supported transaction identifier,
 * or false when the input does not have a persisted transaction hash shape.
 */
function canonicalTransactionHash(value){
    if(typeof value !== 'string')
        return false;
    if(HEX_TRANSACTION_HASH_RE.test(value))
        return value.toLowerCase();
    if(SYNTHETIC_TRANSACTION_HASH_RE.test(value))
        return value;
    return false;
}

module.exports = { canonicalTransactionHash };
