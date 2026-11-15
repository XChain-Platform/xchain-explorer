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
 * XChain Explorer - Broadcaster, coin envelope map
 *
 * The coin to chain/network table every Broadcaster frame builder stamps its
 * envelope from. It sits in its own module because both broadcaster.js and
 * broadcaster/mempool.js build frames, and a part cannot require the entry that
 * requires it without receiving a half-built module.
 *
 ********************************************************************/

'use strict';

const { baseCoinTables } = require('../../config/resolve_coins.js');
const { getLogger } = require('../../observability');
const log = getLogger();
const unmappedCoins = new Set();

function buildCoinMap(tables) {
    const map = {};
    for (const chain of Object.keys(tables.COIN_NETWORKS || {})) {
        for (const [network, prefix] of Object.entries(tables.COIN_PREFIXES || {}))
            map[prefix + chain] = { chain, network };
    }
    return map;
}

const COIN_MAP = buildCoinMap(baseCoinTables());

function envelopeFor(coin) {
    const info = COIN_MAP[coin];
    if (!info && !unmappedCoins.has(coin)) {
        unmappedCoins.add(coin);
        log.warn('WS_COIN_UNMAPPED', { coin });
    }
    return info;
}

module.exports = { COIN_MAP, buildCoinMap, envelopeFor };
