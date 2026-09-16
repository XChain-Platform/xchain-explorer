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
 * XChain Explorer - per-action-type list readers
 *
 * The /{COIN}/api/<action> and /{COIN}/explorer/<action> feed queries, one
 * method per action type. Extracted out of db/index.js because these are the
 * largest single
 * family in db/index.js and they share nothing with each other but the query
 * pipeline, so they move as a unit and db/index.js stops growing every time an
 * action type is added.
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

module.exports = composeReaderParts(require('./action_lists/dispensers.js'), require('./action_lists/orders.js'), require('./action_lists/swaps.js'), require('./action_lists/tokens.js'), require('./action_lists/transfers.js'), require('./action_lists/content.js'), require('./action_lists/coinpay.js'));
