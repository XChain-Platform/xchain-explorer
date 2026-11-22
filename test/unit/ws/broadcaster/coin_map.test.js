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
const sinon = require('sinon');
const { getLogger } = require('../../../../src/observability');
const { baseCoinTables } = require('../../../../src/config/resolve_coins.js');
const { COIN_MAP, buildCoinMap, envelopeFor } = require('../../../../src/ws/broadcaster/coin_map.js');

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

    it('derives the live map from the base coin tables', () => {
        expect(COIN_MAP).to.deep.equal(buildCoinMap(baseCoinTables()));
    });

    it('expands additional chains and network prefixes without another table edit', () => {
        const map = buildCoinMap({
            COIN_NETWORKS: { BTC: 'Bitcoin', BCH: 'Bitcoin Cash' },
            COIN_PREFIXES: { mainnet: '', testnet: 'T', signet: 'S' }
        });
        expect(map).to.deep.equal({
            BTC:  { chain: 'BTC', network: 'mainnet' },
            TBTC: { chain: 'BTC', network: 'testnet' },
            SBTC: { chain: 'BTC', network: 'signet' },
            BCH:  { chain: 'BCH', network: 'mainnet' },
            TBCH: { chain: 'BCH', network: 'testnet' },
            SBCH: { chain: 'BCH', network: 'signet' }
        });
    });

    it('warns only once when a frame names an unmapped coin', () => {
        const warn = sinon.stub(getLogger(), 'warn');
        expect(envelopeFor('UNMAPPED_TEST')).to.equal(undefined);
        expect(envelopeFor('UNMAPPED_TEST')).to.equal(undefined);
        expect(warn.calledOnceWith('WS_COIN_UNMAPPED', { coin: 'UNMAPPED_TEST' })).to.equal(true);
        warn.restore();
    });

});
