/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 */

'use strict';

// The pre-fix predicate shape, kept verbatim as the NEGATIVE CONTROL. If the
// corpus below ever stops catching this, the corpus has gone blind, not safe.
const PRE_FIX_PREDICATE = "LOWER(TRIM(t.description)) REGEXP '^action:((btc|ltc|doge):)?([0-9]+)$'";

// Descriptions the live resolver RESOLVES. The predicate must still reach these
// or the fix never lands on the rows it exists for.
const RESOLVABLE = [
    'action:12', 'action:BTC:5', 'ACTION:12', 'Action:BTC:5',
    'action:ltc:7', 'ACTION:DOGE:99', 'aCtIoN:DoGe:1', '  action:7  ',
];

// Descriptions the live resolver returns null for. Every one is `action:`-shaped
// enough to tempt a loose predicate; none may ever be selected. The U+0130 pair
// is the attacker-mintable case this tier was written for.
const UNRESOLVABLE = [
    'action:foo', 'action:BTC:', 'action:', 'action:12a',
    'action:XYZ:5', 'action:0x10', 'action: 12', 'Action:hello',
    'ACTİON:12', 'ACTİON:BTC:5', 'actİon:12',
    'actıon:12', 'ACTION：12', 'ＡＣＴＩＯＮ:12',
];

module.exports = { PRE_FIX_PREDICATE, RESOLVABLE, UNRESOLVABLE };
