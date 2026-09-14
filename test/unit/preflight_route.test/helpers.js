/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Unit tests for XChainExplorer.processPreflightRequest: the
 * input-validation + proxy shape of the public /{COIN}/api/preflight
 * route, exercised without a DB by calling the method on a minimal
 * `this` and asserting the mock res. Mirrors the sibling
 * processFeeQuoteRequest hardening.
 */

'use strict';

// A realistic bulk child issuance: n sub-commands, each naming a child tick and a
// metadata URI, exactly as the BATCH issuance rework composes them. At n=250 (the
// consensus command cap) this is ~17,500 characters, which is the whole point: it is
// the LARGEST legal batch and was the one shape the old flat 8192 cap refused.
function batchParams(n) {
    const commands = [];
    for (let i = 1; i <= n; i++) {
        const child = 'JDOG.CARD' + String(i).padStart(3, '0');
        commands.push('ISSUE|0|' + child + '|1|1|0|https://example.com/json/' + child + '.json');
    }
    return '0|' + commands.join(';');
}

module.exports = { batchParams };
