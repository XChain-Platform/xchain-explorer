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
 * XChain Explorer - freshness, mempool, fee and price readers
 *
 * Proposal B stage 4: everything that answers "is what this instance is serving
 * current, and what does it cost right now". The tip probes the WebSocket
 * ChangeDetector polls every cycle, the staleness and future-skew thresholds and
 * the per-coin freshness snapshot built from them, the replica-halt check, the
 * decoder tip and mempool reads, and the fee and price lookups.
 *
 * The thresholds live here rather than in config because every one of them has a
 * per-coin override and a documented default, and the method that reads the
 * override is the one that owns the fallback.
 *
 * WHERE THE SOURCE LIVES
 *
 * The family still reaches db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size a
 * file should have:
 *
 *   - health/tip.js      the indexed-tip probes, the staleness and future-skew
 *                        thresholds, the per-coin freshness snapshot and the
 *                        replica-halt check
 *   - health/decoder.js  everything read from the decoder rather than from this
 *                        instance's own tables: its tip, its block times and the
 *                        mempool snapshot with the row decoding that filters it
 *   - health/prices.js   the fee estimate and the USD coin price
 *
 * The threshold constants sit with the tip part because the methods that read a
 * per-coin override are the only readers of their defaults.
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
const tipMethods     = require('./health/tip.js');
const decoderMethods = require('./health/decoder.js');
const priceMethods   = require('./health/prices.js');

module.exports = composeReaderParts(tipMethods, decoderMethods, priceMethods);
