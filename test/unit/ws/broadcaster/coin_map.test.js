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

const { expect } = require('chai');
const { COIN_MAP } = require('../../../../src/ws/broadcaster/coin_map.js');

describe('broadcaster coin map', () => {

    it('contains exactly the supported coin keys', () => {
        expect(Object.keys(COIN_MAP)).to.have.members([
            'BTC', 'LTC', 'DOGE',
            'TBTC', 'TLTC', 'TDOGE',
            'RBTC', 'RLTC', 'RDOGE'
        ]).and.to.have.length(9);
    });

    it('maps each coin key to its chain and network', () => {
        expect(COIN_MAP).to.deep.equal({
            BTC:   { chain: 'BTC',  network: 'mainnet' },
            LTC:   { chain: 'LTC',  network: 'mainnet' },
            DOGE:  { chain: 'DOGE', network: 'mainnet' },
            TBTC:  { chain: 'BTC',  network: 'testnet' },
            TLTC:  { chain: 'LTC',  network: 'testnet' },
            TDOGE: { chain: 'DOGE', network: 'testnet' },
            RBTC:  { chain: 'BTC',  network: 'regtest' },
            RLTC:  { chain: 'LTC',  network: 'regtest' },
            RDOGE: { chain: 'DOGE', network: 'regtest' }
        });
    });

});
