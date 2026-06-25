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
 * XChain Explorer - COIN Config Adapter
 *
 * Maps the canonical coin definition (src/coins/<COIN>.js) into the display
 * shape the explorer's configs/<COIN>.js has always returned: a chain identity
 * block plus a lowercase address map. The canonical UPPERCASE roles map to the
 * explorer's display names (DONATE1 -> protocol, DONATE2 -> community).
 *
 ********************************************************************/

const coins = require('../coins');

function toExplorerConfig(tick, network){
    const c = coins.getCoinConfig(tick, network);
    return {
        chain: {
            name: c.displayName,
            tick: c.tick,
            site: c.site,
        },
        address: {
            burn:      c.addresses.BURN,
            gas:       c.addresses.GAS,
            protocol:  c.addresses.DONATE1,
            community: c.addresses.DONATE2,
            explorer:  c.addresses.EXPLORER,
        },
    };
}

module.exports = { toExplorerConfig };
