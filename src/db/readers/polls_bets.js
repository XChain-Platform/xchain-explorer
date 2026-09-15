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
 * XChain Explorer - poll, vote, bet and oracle readers
 *
 * Proposal B stage 4: the two prediction surfaces and the oracle they both lean
 * on. VOTE polls with their tallies and votes, BET feeds with their pools,
 * timeline, winning outcome and the wagers against them, and the oracle stats,
 * price records and earned-fee rollups.
 *
 * Polls and bets share a module because they share a failure mode: both carry
 * their lifecycle in a plain status column the indexer rewrites in place rather
 * than as a new action row, so a reader here that caches its answer serves a
 * frozen verdict on a resolved round. MUTABLE_ACTION_FIELDS in ../shared.js is
 * the list that keeps those responses out of the action LRU.
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

module.exports = composeReaderParts(require('./polls_bets/polls.js'), require('./polls_bets/bets.js'), require('./polls_bets/oracle.js'));
