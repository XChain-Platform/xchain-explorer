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
 * XChain Explorer - COIN Configuration - Kaspa (KAS)
 *
 * Thin adapter over the canonical coin definition in src/coins/KASPA.js,
 * same shape as BTC.js / DOGE.js / LTC.js.
 *
 * One family difference worth stating here: KASPA.js declares `net: null`
 * because this chain has no bitcoinjs network object (addresses are
 * bech32-style with a prefix that is covered by the checksum; see the
 * FAMILY block in the coin file). Anything in the explorer that reaches for
 * `net` for a Kaspa network would be wrong to silently paper over, so it is
 * left to surface.
 *
 ********************************************************************/
const { toExplorerConfig } = require('./to_explorer_config');

module.exports = {
    getConfig: function(network){
        return toExplorerConfig('KAS', network);
    }
};
