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

// Map coin prefix to chain/network for event envelope
const COIN_MAP = {};
['BTC', 'LTC', 'DOGE'].forEach(chain => {
    COIN_MAP[chain]       = { chain, network: 'mainnet' };
    COIN_MAP['T' + chain] = { chain, network: 'testnet' };
    COIN_MAP['R' + chain] = { chain, network: 'regtest' };
});

module.exports = { COIN_MAP };
