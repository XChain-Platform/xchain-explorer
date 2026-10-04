'use strict';

const assert = require('assert');

const { flattenHubConfig } = require('../../../src/config/apply_hub_values.js');

describe('config/apply_hub_values', function(){
    it('overwrites generated keys while preserving unowned values', function(){
        const config = { BTC: 'Bitcoin', applicationMode: 'unchanged' };
        const configBefore = structuredClone(config);
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

        const result = flattenHubConfig(hub, config, new Set(), { warn(){} });

        assert.deepStrictEqual(result, [{
            coin: 'hub-coin',
            network: 'hub-network',
            custom: { enabled: true }
        }]);
        assert.strictEqual(result[0].custom, custom);
        assert.deepStrictEqual(config, configBefore);
    });

    it('leaves the config unchanged when the hub payload is absent or empty', function(){
        for(const hub of [undefined, null, {}]){
            const config = { BTC: 'Bitcoin', applicationMode: 'unchanged' };
            const before = structuredClone(config);

            const result = flattenHubConfig(hub, config, new Set(), { warn(){} });

            assert.deepStrictEqual(result, []);
            assert.deepStrictEqual(config, before);
        }
    });

    it('does not mutate the input hub object', function(){
        const hub = {
            bitcoin: {
                mainnet: {
                    'xchain-indexer': { host: 'indexer' },
                    'xchain-decoder': { host: 'decoder' }
                }
            }
        };
        const before = structuredClone(hub);

        flattenHubConfig(hub, { BTC: 'Bitcoin' }, new Set(), { warn(){} });

        assert.deepStrictEqual(hub, before);
    });
});
