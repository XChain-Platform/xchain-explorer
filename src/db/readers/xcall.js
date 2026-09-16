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
 * XChain Explorer - cross-chain call, anchor and attestation readers
 *
 * Proposal B stage 4: the XCALL request and execution feeds and one call's
 * composed detail, the ANCHOR list, one anchor's detail and its commitments, and
 * the ATTEST request/response pairs with the expiry correlation that links an
 * ATTEST v2 expiry back to the request it resolved.
 *
 * The expiry helpers are the reason these three families share a module. An
 * expiry writes no row of its own: it flips a status column and stamps a block
 * on the request, so the only way to render "this request expired" is to
 * correlate the later action back onto the earlier one, and XCALL and ATTEST
 * both do it the same way against rows an anchor commits.
 *
 * WHERE THE SOURCE LIVES
 *
 * The family still reaches db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size a
 * file should have:
 *
 *   - xcall/lists.js         the four paged lists: ATTEST, XCALL, ANCHOR and the
 *                            per-block SPV commitments
 *   - xcall/xcall_detail.js  one call's composed lifecycle, its WS snapshot read
 *                            and the phase-transition feed
 *   - xcall/attestation.js   the expiry correlation, the derived callback, the
 *                            composed ATTESTATION detail and its WS reads
 *   - xcall/anchor.js        one ANCHOR's composed detail, cut into one read per
 *                            section the anchor page renders
 *
 * The expiry helpers stay in one part with the attestation detail that calls
 * them, so the correlation and its only composed consumer are read together.
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

// The four method parts. composeReaderParts throws at require time if two of them
// declare the same name, so a method moved between parts cannot shadow another.
const listMethods        = require('./xcall/lists.js');
const xcallDetailMethods = require('./xcall/xcall_detail.js');
const attestationMethods = require('./xcall/attestation.js');
const anchorMethods      = require('./xcall/anchor.js');

module.exports = composeReaderParts(listMethods, xcallDetailMethods, attestationMethods, anchorMethods);
