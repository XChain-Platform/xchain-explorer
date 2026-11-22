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
 * Verify block identities already delivered by the change detector.
 */

'use strict';

async function verifyDelivered(detector, config, prev) {
    if (prev.pendingReorg || typeof detector.db.getBlockHashesSince !== 'function') return;
    const history = prev.history;
    if (!history) return;
    const cursor = Number(prev.blockIndex);
    const heights = [...history.keys()].filter((height) => height >= cursor).sort((a, b) => a - b);
    if (!heights.length) return;
    const low = heights[0];
    const high = heights[heights.length - 1];
    const rows = await detector.db.getBlockHashesSince(config, low - 1, high - low + 1);
    const current = new Map((rows || []).map((row) => [Number(row.block_index), row.block_hash || null]));
    const replaced = heights.some((height) => {
        if (!current.has(height)) return true;
        const known = history.get(height).hash;
        // A null hash can prove only that the row still exists.
        return known !== null && current.get(height) !== known;
    });
    if (!replaced) return;
    prev.pendingReorg = true;
    if (typeof detector.db.bumpReorgGeneration === 'function')
        detector.db.bumpReorgGeneration(config.coin);
}

module.exports = verifyDelivered;
