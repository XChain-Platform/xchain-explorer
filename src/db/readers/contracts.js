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
 * XChain Explorer - contract readers
 *
 * Proposal B stage 4: deployed contracts and one contract's detail, its
 * manifest, its stored state (paged and whole, both behind the size caps that
 * keep a large state from being fetched before it is refused), its balance, its
 * executions, and the emission, deposit and withdrawal rollups that hang off
 * those executions.
 *
 * The AST introspection cache is keyed by a sha256 of the contract source rather
 * than by the stored code_hash column, because code is immutable once deployed
 * and the stored hash is unverified; that is why crypto and the introspector are
 * required by the detail part below and nowhere else in src/db/.
 *
 * WHERE THE SOURCE LIVES
 *
 * The family still reaches db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size a
 * file should have:
 *
 *   - contracts/contracts.js   the contract list, one contract's detail and the
 *                              manifest and metadata that decorate it
 *   - contracts/state.js       the stored state reads (paged, whole and by
 *                              balance) behind their size caps
 *   - contracts/executions.js  the execution feed, one execution, and the
 *                              emission, deposit and withdrawal rollups
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

// The three method parts. composeReaderParts throws at require time if two of them
// declare the same name, so a method moved between parts cannot shadow another.
const contractMethods  = require('./contracts/contracts.js');
const stateMethods     = require('./contracts/state.js');
const executionMethods = require('./contracts/executions.js');

module.exports = composeReaderParts(contractMethods, stateMethods, executionMethods);
