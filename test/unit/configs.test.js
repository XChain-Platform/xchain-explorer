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
 * Unit tests for the per-coin config modules (src/configs/*.js).
 */

'use strict';

const { expect } = require('chai');

const COINS = {
    BTC: { name: 'Bitcoin',  tick: 'BTC' },
    LTC: { name: 'Litecoin', tick: 'LTC' },
    DOGE: { name: 'Dogecoin', tick: 'DOGE' }
};

describe('configs/*', function () {
    for (let coin of Object.keys(COINS)) {
        describe(coin + '.js', function () {
            const cfgModule = require('../../src/configs/' + coin + '.js');

            it('returns the chain identity', function () {
                let c = cfgModule.getConfig('mainnet');
                expect(c.chain.name).to.equal(COINS[coin].name);
                expect(c.chain.tick).to.equal(COINS[coin].tick);
            });

            ['mainnet', 'testnet', 'regtest'].forEach(function (network) {
                it('provides the full address set for ' + network, function () {
                    let c = cfgModule.getConfig(network);
                    expect(c.address).to.include.all.keys('burn', 'gas', 'protocol', 'community', 'explorer');
                    for (let k of ['burn', 'gas', 'protocol', 'community', 'explorer']) {
                        expect(c.address[k], coin + '/' + network + '/' + k).to.be.a('string').and.have.length.greaterThan(0);
                    }
                });
            });

            it('returns an empty address set for an unknown network', function () {
                let c = cfgModule.getConfig('nope');
                expect(c.address).to.deep.equal({});
                expect(c.chain.tick).to.equal(COINS[coin].tick);
            });
        });
    }
});
