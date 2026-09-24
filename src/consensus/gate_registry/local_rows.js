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
 *
 * Explorer-owned activation rows that are not part of the shared gate block.
 *
 ********************************************************************/

'use strict';

// Register the DOGE height where the current ANCHOR wire set begins. Mainnet
// and testnet retain older anchor history, while regtest starts from genesis.
function registerLocalRows(registry) {
    registry.addGate('anchor_activation.ANCHOR_ACTIVATION', 'height', {
        mainnet: 6360000,
        testnet: 67858600,
        regtest: 0,
    });
}

module.exports = { registerLocalRows };
