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
 * XChain Explorer - checkpoint, state-tree and since-cursor readers
 *
 * Proposal B stage 4: the
 * hub-mirrored checkpoint tables and their source selection, the state-tree
 * and net-balance readers that hang off them, capability snapshots, and the
 * two since-cursor feeds (getBlocksSince, getActionsSince) that the WebSocket
 * ChangeDetector polls.
 *
 * WHERE THE SOURCE LIVES
 *
 * The family still reaches db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size a
 * file should have:
 *
 *   - checkpoints/sources.js      checkpoint, match, oracle and hub source
 *                                 selection, the fail-loud outage, and the row
 *                                 normalizers
 *   - checkpoints/checkpoints.js  the checkpoint list, detail and verify reads,
 *                                 the reward attestations, and the signed
 *                                 checkpoint lookups a proof binds to
 *   - checkpoints/state.js        state-tree roots and nodes, the as-of-height
 *                                 balances, and the canonical block leaf rows
 *   - checkpoints/sync_feeds.js   capability snapshots, the since-cursor feeds,
 *                                 and the hub operational-state pages
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
 * The move is verbatim: no module-level binding from db/index.js is referenced from
 * any method in the parts, which is what made this family safe to lift whole.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('../reader_parts.js');

// The four method parts. composeReaderParts throws at require time if two of them
// declare the same name, so a method moved between parts cannot shadow another.
const sourceMethods     = require('./checkpoints/sources.js');
const checkpointMethods = require('./checkpoints/checkpoints.js');
const stateMethods      = require('./checkpoints/state.js');
const syncFeedMethods   = require('./checkpoints/sync_feeds.js');

module.exports = composeReaderParts(sourceMethods, checkpointMethods, stateMethods, syncFeedMethods);
