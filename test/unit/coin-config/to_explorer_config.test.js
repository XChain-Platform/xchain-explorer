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

const assert = require('assert');

const { toExplorerConfig } = require('../../../src/coin-config/to_explorer_config.js');
const coins = require('../../../src/coins');

describe('toExplorerConfig', function(){
    it('maps a real network config to the display shape, with DONATE1/DONATE2 renamed', function(){
        const c = coins.getCoinConfig('BTC', 'regtest');
        const out = toExplorerConfig('BTC', 'regtest');

        assert.deepStrictEqual(out.chain, {
            name: c.displayName,
            tick: c.tick,
            site: c.site
        });
        assert.deepStrictEqual(out.address, {
            burn:      c.addresses.BURN,
            gas:       c.addresses.GAS,
            protocol:  c.addresses.DONATE1,
            community: c.addresses.DONATE2,
            explorer:  c.addresses.EXPLORER
        });
    });

    it('returns the mainnet-read identity with an empty address map for an unknown network', function(){
        const mainnet = coins.getCoinConfig('BTC', 'mainnet');
        const out = toExplorerConfig('BTC', 'not-a-real-network');

        assert.deepStrictEqual(out, {
            chain: { name: mainnet.displayName, tick: mainnet.tick, site: mainnet.site },
            address: {}
        });
    });

    it('reads the identity fields network-independently for every real network', function(){
        for(const network of coins.NETWORKS){
            const out = toExplorerConfig('LTC', network);
            const c = coins.getCoinConfig('LTC', network);
            assert.strictEqual(out.chain.name, c.displayName);
            assert.strictEqual(out.chain.tick, c.tick);
            assert.strictEqual(out.chain.site, c.site);
        }
    });
});
