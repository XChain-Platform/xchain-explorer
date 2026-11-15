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
 ********************************************************************/

'use strict';

const DECIMAL_SCALE = 10n ** 18n;

function toUnits(amount) {
    const text = String(amount).trim();
    const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!match || (match[3] || '').length > 18) {
        throw new Error(`Invalid exact decimal amount: ${text}`);
    }
    const fraction = (match[3] || '').padEnd(18, '0');
    const units = BigInt(match[2]) * DECIMAL_SCALE + BigInt(fraction || '0');
    return match[1] ? -units : units;
}

function fromUnits(units) {
    const negative = units < 0n;
    const absolute = negative ? -units : units;
    const fraction = String(absolute % DECIMAL_SCALE).padStart(18, '0');
    return `${negative ? '-' : ''}${absolute / DECIMAL_SCALE}.${fraction}`;
}

module.exports = { toUnits, fromUnits };
