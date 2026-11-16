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
 * XChain Explorer - wallet range readers
 *
 * The many-address and many-asset range reads a wallet's value-over-time chart
 * is built from: batch address history with per-address balance effects, and
 * downsampled oracle and DEX price series. Every reader here answers a whole
 * request in a fixed number of statements.
 *
 * Composed from the part files under wallet_reads/ by composeReaderParts, like
 * every split family; db/index.js copies the result onto Database.prototype.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('../reader_parts.js');

module.exports = composeReaderParts(require('./wallet_reads/address_history.js'), require('./wallet_reads/price_history.js'));
