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
 * XChain Explorer - market readers
 *
 * markets, one market, market history, market orders and the orderbook.
 * One of the reader families extracted out of db/index.js.
 *
 * WHY EVERY TICKER JOIN HERE IS A LEFT JOIN
 *
 * A market side is a token OR the chain's native coin, and the coin has no
 * index_tickers row: markets.tickN_id is 0 for it and orders/order_matches carry
 * NULL. An inner join on the ticker therefore dropped the whole pair, so a market
 * with any number of resting orders answered as an empty list. Each side is
 * labelled COALESCE(ticker, coin), which leaves a token/token pair byte-identical
 * and names a native side by its coin, the same value the order feeds already
 * return in get_coin / give_coin.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as class bodies in sibling part files, and
 * composeReaderParts folds their prototypes into one object exported here.
 * db/index.js copies that object onto Database.prototype by descriptor. Part
 * classes are never instantiated: `this` is the Database instance at call time,
 * so every helper (this.doQuery, this.util, this.explorer, ...) resolves through
 * Database.prototype. The composed object keeps every method name and descriptor
 * expected by callers. A single object literal would need a comma between every
 * method, making method-only moves harder to review.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('../reader_parts.js');

module.exports = composeReaderParts(require('./markets/overview.js'), require('./markets/orders.js'));
