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
 * XChain Explorer - entity readers
 *
 * Proposal B stage 4: the things a URL names. Actions, addresses, blocks,
 * balances, tokens, transactions and the /api endpoints that serve them, the
 * id-resolution lookups every other family calls (getAddressId, getTickId), the
 * single-entity snapshots the WebSocket layer fans out on subscribe, the two
 * FILE byte readers, and the per-token rich list with its supply helpers.
 *
 * These travel together because they share the id-resolution cache path: a page
 * for one entity resolves its key through the same memoised lookups the feeds
 * use, so splitting the resolvers away from their callers would leave one file
 * holding a cache and another holding every reason it is warm.
 *
 * WHERE THE SOURCE LIVES
 *
 * The family still reaches db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size a
 * file should have:
 *
 *   - entities/actions.js    the ACTION and TRANSACTION reads: one action, the
 *                            action feed, the history feed and the tx-hash reads
 *   - entities/blocks.js     one block and the block list
 *   - entities/addresses.js  one address and the per-address balance, credit,
 *                            debit, escrow and holder feeds
 *   - entities/resolvers.js  the memoised address-id and tick-id lookups every
 *                            other family calls to turn a string into a row id
 *   - entities/network.js    the mempool feed, /api/network and the action-total
 *                            counters it serves, with their tip generation guard
 *   - entities/status.js     /api/status, the one read that answers for every
 *                            served coin at once
 *   - entities/tokens.js     one token and the files linked to it
 *   - entities/rich_list.js  the per-token rich list and its supply helpers
 *   - entities/lookups.js    the FILE byte readers and the single-row snapshots
 *                            the WebSocket layer reads on subscribe
 *
 * The id resolvers sit in their own part rather than beside any one caller:
 * every other part calls them, so filing them under a caller would have picked
 * one of those callers arbitrarily.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as class bodies (one per part) and
 * composeReaderParts folds their prototypes into the one object exported here,
 * so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('../reader_parts.js');

// The nine method parts. composeReaderParts throws at require time if two of them
// declare the same name, so a method moved between parts cannot shadow another.
const actionMethods   = require('./entities/actions.js');
const blockMethods    = require('./entities/blocks.js');
const addressMethods  = require('./entities/addresses.js');
const resolverMethods = require('./entities/resolvers.js');
const networkMethods  = require('./entities/network.js');
const statusMethods   = require('./entities/status.js');
const tokenMethods    = require('./entities/tokens.js');
const richListMethods = require('./entities/rich_list.js');
const lookupMethods   = require('./entities/lookups.js');

module.exports = composeReaderParts(actionMethods, blockMethods, addressMethods, resolverMethods, networkMethods, statusMethods, tokenMethods, richListMethods, lookupMethods);
