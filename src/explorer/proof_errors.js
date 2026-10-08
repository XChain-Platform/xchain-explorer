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
 * XChain Explorer - proof route error replies
 *
 * Turns a proof builder's error code into the HTTP reply. The `code` field is
 * the stable, registered value clients branch on, so a code the route's map does
 * not register answers SERVER_ERROR and its raw text goes to the log instead.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability');
const log = getLogger();

// Send the mapped reply for `code`, or SERVER_ERROR with the raw error logged.
function sendProofError(res, map, code, raw){
    const hit = Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null;
    if(hit) return res.status(hit[0]).json({ error: hit[1], code });
    log.error('PROOF_UNMAPPED_ERROR', { err: String(raw === undefined ? code : raw) });
    return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
}

module.exports = { sendProofError };
