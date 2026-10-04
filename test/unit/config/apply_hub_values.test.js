'use strict';

const assert = require('assert');

const {
    flattenHubConfig,
    hubFallbackOutcome
} = require('../../../src/config/apply_hub_values.js');

function stubLogger(){
    const calls = [];
    return {
        calls,
        error(event, details){ calls.push({ level: 'error', event, details }); },
        warn(event, details){ calls.push({ level: 'warn', event, details }); }
    };
}

const coinNetworks = { BTC: 'Bitcoin', LTC: 'Litecoin' };

describe('flattenHubConfig', function(){
    it('returns one entry per known coin and network with every service', function(){
        const hub = {
            bitcoin: {
                mainnet: {
                    'xchain-indexer': { host: 'btc-indexer' },
                    'xchain-decoder': { host: 'btc-decoder' }
                },
                testnet: { 'xchain-indexer': { host: 'btc-test-indexer' } }
            },
            litecoin: {
                mainnet: { 'xchain-indexer': { host: 'ltc-indexer' } }
            }
        };

        assert.deepStrictEqual(flattenHubConfig(hub, coinNetworks, new Set(), stubLogger()), [
            {
                coin: 'BTC',
                network: 'mainnet',
                'xchain-indexer': { host: 'btc-indexer' },
                'xchain-decoder': { host: 'btc-decoder' }
            },
            { coin: 'BTC', network: 'testnet', 'xchain-indexer': { host: 'btc-test-indexer' } },
            { coin: 'LTC', network: 'mainnet', 'xchain-indexer': { host: 'ltc-indexer' } }
        ]);
    });
});

describe('flattenHubConfig entry ownership', function(){
    it('lets hub-owned keys overwrite generated keys and preserves other keys', function(){
        const custom = { enabled: true };
        const hub = {
            bitcoin: {
                mainnet: {
                    coin: 'hub-coin',
                    network: 'hub-network',
                    custom
                }
            }
        };

        const result = flattenHubConfig(hub, coinNetworks, new Set(), stubLogger());

        assert.deepStrictEqual(result, [{
            coin: 'hub-coin',
            network: 'hub-network',
            custom: { enabled: true }
        }]);
        assert.strictEqual(result[0].custom, custom);
    });

    it('does not mutate the hub tree or coin map', function(){
        const hub = {
            bitcoin: {
                mainnet: { 'xchain-indexer': { host: 'indexer' } }
            }
        };
        const hubBefore = structuredClone(hub);
        const networksBefore = structuredClone(coinNetworks);

        flattenHubConfig(hub, coinNetworks, new Set(), stubLogger());

        assert.deepStrictEqual(hub, hubBefore);
        assert.deepStrictEqual(coinNetworks, networksBefore);
    });
});

describe('flattenHubConfig warnings', function(){
    it('skips an unknown coin and warns only once across calls', function(){
        const warned = new Set();
        const log = stubLogger();
        const hub = { chain_tips: { BTC: { height: 10 } } };

        assert.deepStrictEqual(flattenHubConfig(hub, coinNetworks, warned, log), []);
        assert.deepStrictEqual(flattenHubConfig(hub, coinNetworks, warned, log), []);
        assert.deepStrictEqual([...warned], ['chain_tips']);
        assert.deepStrictEqual(log.calls, [{
            level: 'warn',
            event: 'CONFIG_UNKNOWN_COIN_KEY_SKIPPED',
            details: { key: 'chain_tips' }
        }]);
    });
});

describe('hubFallbackOutcome', function(){
    it('serves an in-memory config without loading disk', function(){
        const log = stubLogger();
        let diskLoads = 0;

        const result = hubFallbackOutcome('unreachable', {
            cachedConfig: { configs: [{ coin: 'BTC' }] },
            loadDiskCache(){ diskLoads += 1; },
            log
        });

        assert.deepStrictEqual(result, { serveCache: true });
        assert.strictEqual(diskLoads, 0);
        assert.deepStrictEqual(log.calls, [{
            level: 'error',
            event: 'CONFIG_HUB_UNUSABLE_SERVING_CACHE',
            details: {
                cause: 'unreachable',
                detail: 'serving last-known-good cached config (may be stale until the hub recovers)'
            }
        }]);
    });
});

describe('hubFallbackOutcome cold start', function(){
    it('returns the disk copy when no in-memory config exists', function(){
        const diskConfig = { configs: [{ coin: 'LTC' }] };
        const log = stubLogger();

        const result = hubFallbackOutcome('empty', {
            cachedConfig: null,
            loadDiskCache(){ return diskConfig; },
            log
        });

        assert.deepStrictEqual(result, { jsonConfig: diskConfig });
        assert.strictEqual(result.jsonConfig, diskConfig);
        assert.deepStrictEqual(log.calls, [{
            level: 'warn',
            event: 'CONFIG_HUB_UNUSABLE_LOADING_DISK_CACHE',
            details: { cause: 'empty', entries: 1 }
        }]);
    });

    it('returns an empty config and clears the timestamp without any cache', function(){
        const log = stubLogger();

        const result = hubFallbackOutcome('empty', {
            cachedConfig: null,
            loadDiskCache(){ return null; },
            log
        });

        assert.deepStrictEqual(result, {
            jsonConfig: { configs: [] },
            clearLastObtained: true
        });
        assert.deepStrictEqual(log.calls, [{
            level: 'warn',
            event: 'CONFIG_HUB_UNUSABLE_DEGRADED_START',
            details: {
                cause: 'empty',
                detail: 'no config cache is available; starting in degraded mode (no coins configured); the sync loop retries every UPDATE_CONFIG_INTERVAL ms'
            }
        }]);
    });
});
