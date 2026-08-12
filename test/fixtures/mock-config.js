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
 * Mock configuration fixtures for xchain-explorer unit tests
 */

// Standard config object as returned by configInfo.getConfig()
function getFullConfig() {
    return {
        COIN_NETWORKS: {
            BTC: 'Bitcoin',
            LTC: 'Litecoin',
            DOGE: 'Dogecoin'
        },
        COIN_PREFIXES: {
            mainnet: '',
            testnet: 'T',
            regtest: 'R'
        },
        COIN_SUPPORTED: {
            BTC: 'Bitcoin (mainnet)',
            TBTC: 'BTC (testnet)',
            RBTC: 'BTC (regtest)',
            LTC: 'Litecoin (mainnet)',
            TLTC: 'LTC (testnet)',
            RLTC: 'LTC (regtest)',
            DOGE: 'Dogecoin (mainnet)',
            TDOGE: 'DOGE (testnet)',
            RDOGE: 'DOGE (regtest)'
        },
        COIN_AVAILABLE: {
            BTC: 'BTC (mainnet)',
            RBTC: 'BTC (regtest)'
        },
        DISPENSER_LIST_DELAY: 3600,
        API: {
            host: '127.0.0.1',
            user: false,
            pass: false,
            ssl: { key: 'mock', cert: 'mock', ca: 'mock' },
            port: { http: 8080, https: 8081 }
        },
        BTC: {
            chain: { name: 'Bitcoin', tick: 'BTC', site: 'https://bitcoin.org' },
            mainnet: {
                database: {
                    indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer' },
                    decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Decoder' },
                    // Mandatory co-located hub DB for the hub-mirrored tables. A serving
                    // node must declare this; the explorer asserts it at startup and reads
                    // state_checkpoints / capability_snapshots / cross_chain_matches from it.
                    checkpoint: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_Hub' }
                },
                address: {
                    burn: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    gas: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    protocol: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    community: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    explorer: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
                }
            },
            regtest: {
                database: {
                    indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer' },
                    decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Decoder' },
                    checkpoint: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_Hub' }
                },
                address: {
                    burn: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    gas: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    protocol: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    community: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    explorer: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
                }
            }
        }
    };
}

// Hub JSON response format (as returned by hubConnector.getAllConfig())
function getHubConfig() {
    return {
        bitcoin: {
            mainnet: {
                indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer' },
                decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Decoder' }
            }
        }
    };
}

// File config.json format
function getFileConfig() {
    return {
        configs: [
            { coin: 'BTC', network: 'mainnet', indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Indexer' }, decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Mainnet_Decoder' } },
            { coin: 'BTC', network: 'regtest', indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer' }, decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Decoder' } }
        ]
    };
}

// Minimal configInfo stub that behaves like src/config.js
function createConfigInfoStub(configOverrides) {
    const config = configOverrides || getFullConfig();
    const listeners = [];
    return {
        getConfig: async function() { return config; },
        onConfigChanged: function(cb) { listeners.push(cb); },
        triggerConfigChanged: function() { listeners.forEach(cb => cb()); },
        _listeners: listeners
    };
}

module.exports = {
    getFullConfig,
    getHubConfig,
    getFileConfig,
    createConfigInfoStub
};
