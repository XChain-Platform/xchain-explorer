'use strict';

const assert = require('assert');

const {
    flattenHubConfig,
    hubFallbackOutcome
} = require('../../../src/config/apply_hub_values.js');

function loggerSpy(){
    const calls = [];
    return {
        calls,
        error(event, details){ calls.push({ level: 'error', event, details }); },
        warn(event, details){ calls.push({ level: 'warn', event, details }); }
    };
}

const coinNetworks = { BTC: 'Bitcoin', LTC: 'Litecoin' };

describe('config/apply_hub_values', function(){
    it('flattens known hub values and preserves service fields', function(){
        const hub = {
            bitcoin: {
                mainnet: {
                    'xchain-indexer': { host: 'indexer' },
                    'xchain-decoder': { host: 'decoder' },
                    custom: 'untouched'
                }
            }
        };

        const result = flattenHubConfig(hub, coinNetworks, new Set(), loggerSpy());

        assert.deepStrictEqual(result, [{
            coin: 'BTC',
            network: 'mainnet',
            'xchain-indexer': { host: 'indexer' },
            'xchain-decoder': { host: 'decoder' },
            custom: 'untouched'
        }]);
    });

    it('lets hub values overwrite generated entry keys', function(){
        const hub = {
            litecoin: {
                testnet: { coin: 'hub-coin', network: 'hub-network' }
            }
        };

        const result = flattenHubConfig(hub, coinNetworks, new Set(), loggerSpy());

        assert.deepStrictEqual(result, [{ coin: 'hub-coin', network: 'hub-network' }]);
    });
});

describe('config/apply_hub_values', function(){
    it('leaves its inputs unchanged', function(){
        const hub = {
            bitcoin: {
                mainnet: { indexer: { host: 'indexer' } }
            }
        };
        const hubBefore = structuredClone(hub);
        const networksBefore = structuredClone(coinNetworks);

        flattenHubConfig(hub, coinNetworks, new Set(), loggerSpy());

        assert.deepStrictEqual(hub, hubBefore);
        assert.deepStrictEqual(coinNetworks, networksBefore);
    });

    it('returns no entries for an absent or empty hub payload', function(){
        for(const hub of [undefined, null, {}]){
            const warned = new Set();
            const log = loggerSpy();
            const hubBefore = structuredClone(hub);
            const networksBefore = structuredClone(coinNetworks);
            assert.deepStrictEqual(flattenHubConfig(hub, coinNetworks, warned, log), []);
            assert.deepStrictEqual(hub, hubBefore);
            assert.deepStrictEqual(coinNetworks, networksBefore);
            assert.deepStrictEqual([...warned], []);
            assert.deepStrictEqual(log.calls, []);
        }
    });

    it('skips and warns once for each unknown coin key', function(){
        const warned = new Set();
        const log = loggerSpy();
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

describe('config/apply_hub_values', function(){
    it('keeps serving an in-memory config without loading disk', function(){
        const cachedConfig = { configs: [{ coin: 'BTC' }] };
        const log = loggerSpy();
        let diskLoads = 0;

        const result = hubFallbackOutcome('unreachable', {
            cachedConfig,
            loadDiskCache(){ diskLoads += 1; },
            log
        });

        assert.deepStrictEqual(result, { serveCache: true });
        assert.strictEqual(diskLoads, 0);
        assert.strictEqual(log.calls[0].event, 'CONFIG_HUB_UNUSABLE_SERVING_CACHE');
    });

    it('returns the disk config when no in-memory config exists', function(){
        const diskConfig = { configs: [{ coin: 'LTC' }] };
        const log = loggerSpy();

        const result = hubFallbackOutcome('empty', {
            cachedConfig: null,
            loadDiskCache(){ return diskConfig; },
            log
        });

        assert.strictEqual(result.jsonConfig, diskConfig);
        assert.strictEqual(log.calls[0].event, 'CONFIG_HUB_UNUSABLE_LOADING_DISK_CACHE');
        assert.strictEqual(log.calls[0].details.entries, 1);
    });

    it('returns an empty degraded config when no cache exists', function(){
        const log = loggerSpy();

        const result = hubFallbackOutcome('empty', {
            cachedConfig: null,
            loadDiskCache(){ return null; },
            log
        });

        assert.deepStrictEqual(result, {
            jsonConfig: { configs: [] },
            clearLastObtained: true
        });
        assert.strictEqual(log.calls[0].event, 'CONFIG_HUB_UNUSABLE_DEGRADED_START');
    });
});
