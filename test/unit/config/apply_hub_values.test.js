'use strict';

const assert = require('assert');

const { flattenHubConfig } = require('../../../src/config/apply_hub_values.js');

function flatten(hub, config){
    return flattenHubConfig(hub, config, new Set(), { warn(){} });
}

describe('config/apply_hub_values', function(){
    it('lets hub values overwrite owned keys and preserves other keys', function(){
        const config = { BTC: 'Bitcoin' };
        const hub = {
            bitcoin: {
                mainnet: {
                    coin: 'hub-coin',
                    network: 'hub-network',
                    custom: { enabled: true }
                }
            }
        };

        assert.deepStrictEqual(flatten(hub, config), [{
            coin: 'hub-coin',
            network: 'hub-network',
            custom: { enabled: true }
        }]);
    });

    it('leaves the config unchanged when the hub payload is absent or empty', function(){
        for(const hub of [undefined, null, {}]){
            const config = { BTC: 'Bitcoin', LTC: 'Litecoin' };
            const before = structuredClone(config);

            assert.deepStrictEqual(flatten(hub, config), []);
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

        flatten(hub, { BTC: 'Bitcoin' });

        assert.deepStrictEqual(hub, before);
    });
});
