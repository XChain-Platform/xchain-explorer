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
const {
    baseCoinTables,
    applyExplorerSection,
    resolveCoins
} = require('../../../src/config/resolve_coins.js');

function explorerConfig(jsonConfig, api){
    const config = baseCoinTables();
    applyExplorerSection(config, jsonConfig, api);
    return config;
}

describe('resolve_coins base tables', function(){

    it('builds fresh base coin and network tables', function(){
        const first = baseCoinTables();
        const second = baseCoinTables();

        assert.deepStrictEqual(first.COIN_NETWORKS, {
            BTC: 'Bitcoin',
            LTC: 'Litecoin',
            DOGE: 'Dogecoin'
        });
        assert.deepStrictEqual(first.COIN_PREFIXES, {
            mainnet: '',
            testnet: 'T',
            regtest: 'R'
        });
        assert.notStrictEqual(first, second);
        assert.notStrictEqual(first.COIN_NETWORKS, second.COIN_NETWORKS);
        assert.notStrictEqual(first.COIN_PREFIXES, second.COIN_PREFIXES);
    });

});

describe('resolve_coins explorer section', function(){

    it('adds the explorer-wide configuration sections', function(){
        const api = { host: '127.0.0.1', port: 3000 };
        const iconDownload = { enabled: true };
        const config = explorerConfig({ iconDownload }, api);
        const withoutIcon = explorerConfig({ iconDownload: false }, api);

        assert.deepStrictEqual(config.COIN_SUPPORTED, {
            BTC: 'Bitcoin (mainnet)',
            TBTC: 'Bitcoin (testnet)',
            RBTC: 'Bitcoin (regtest)',
            LTC: 'Litecoin (mainnet)',
            TLTC: 'Litecoin (testnet)',
            RLTC: 'Litecoin (regtest)',
            DOGE: 'Dogecoin (mainnet)',
            TDOGE: 'Dogecoin (testnet)',
            RDOGE: 'Dogecoin (regtest)'
        });
        assert.deepStrictEqual(config.COIN_AVAILABLE, {});
        assert.strictEqual(config.DISPENSER_LIST_DELAY, 3600);
        assert.strictEqual(config.API, api);
        assert.strictEqual(config.iconDownload, iconDownload);
        assert.strictEqual(Object.hasOwn(withoutIcon, 'iconDownload'), false);
    });
});

describe('resolve_coins preferred service resolution', function(){

    it('resolves a coin using the preferred service keys', function(){
        const configs = [{
            coin: 'BTC', network: 'testnet',
            'xchain-indexer': 'btc-indexer', indexer: 'legacy-indexer',
            'xchain-decoder': 'btc-decoder', decoder: 'legacy-decoder',
            checkpoint: 'btc-checkpoint'
        }];
        const loaded = {
            chain: { tick: 'BTC' },
            address: { burn: 'btc-burn' }
        };
        const calls = [];
        const config = explorerConfig({}, {});

        resolveCoins(config, { configs }, function(coin, network){
            calls.push([coin, network]);
            return loaded;
        });

        assert.deepStrictEqual(calls, [['BTC', 'testnet']]);
        assert.deepStrictEqual(config.BTC, {
            chain: loaded.chain,
            testnet: {
                database: {
                    indexer: 'btc-indexer',
                    decoder: 'btc-decoder',
                    checkpoint: 'btc-checkpoint'
                },
                address: loaded.address
            }
        });
        assert.strictEqual(config.COIN_AVAILABLE.TBTC, 'BTC (testnet)');
    });
});

describe('resolve_coins fallback and missing handling', function(){

    it('uses legacy service keys and skips a missing coin configuration', function(){
        const configs = [
            {
                coin: 'LTC', network: 'mainnet', indexer: 'ltc-indexer',
                decoder: 'ltc-decoder', checkpoint: 'ltc-checkpoint'
            },
            { coin: 'DOGE', network: 'regtest' }
        ];
        const loaded = {
            chain: { tick: 'LTC' },
            address: { burn: 'ltc-burn' }
        };
        const calls = [];
        const config = explorerConfig({}, {});

        resolveCoins(config, { configs }, function(coin, network){
            calls.push([coin, network]);
            return coin === 'LTC' ? loaded : null;
        });

        assert.deepStrictEqual(calls, [
            ['LTC', 'mainnet'], ['DOGE', 'regtest']
        ]);
        assert.strictEqual(config.LTC.chain, loaded.chain);
        assert.deepStrictEqual(config.LTC.mainnet, {
            database: {
                indexer: 'ltc-indexer',
                decoder: 'ltc-decoder',
                checkpoint: 'ltc-checkpoint'
            },
            address: loaded.address
        });
        assert.strictEqual(config.COIN_AVAILABLE.LTC, 'LTC (mainnet)');
        assert.strictEqual(Object.hasOwn(config, 'DOGE'), false);
        assert.strictEqual(Object.hasOwn(config.COIN_AVAILABLE, 'RDOGE'), false);
    });
});

describe('resolve_coins repeated networks', function(){

    it('keeps the first entry for a repeated coin and network', function(){
        const configs = [
            { coin: 'BTC', network: 'mainnet', indexer: 'first', decoder: 'one' },
            { coin: 'BTC', network: 'mainnet', indexer: 'second', decoder: 'two' }
        ];
        const addresses = [{ burn: 'first' }, { burn: 'second' }];
        const config = explorerConfig({}, {});
        let loadCount = 0;

        resolveCoins(config, { configs }, function(){
            const index = loadCount++;
            return { chain: { tick: 'BTC' }, address: addresses[index] };
        });

        assert.strictEqual(loadCount, 2);
        assert.deepStrictEqual(config.BTC.mainnet, {
            database: {
                indexer: 'first',
                decoder: 'one',
                checkpoint: undefined
            },
            address: addresses[0]
        });
        assert.strictEqual(config.COIN_AVAILABLE.BTC, 'BTC (mainnet)');
    });
});
