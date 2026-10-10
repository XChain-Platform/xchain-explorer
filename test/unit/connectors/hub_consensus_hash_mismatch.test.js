'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const XChainHubConnector = require('../../../src/connectors/hub');
const statusReaders      = require('../../../src/db/readers/entities/status');
const coins              = require('../../../src/coins');

function trueHashes(){
    const out = {};
    for(const network of coins.NETWORKS) out[network] = coins.consensusHashes(network);
    return out;
}

function statusContext(){
    return {
        configInfo: {
            getConfig: async () => ({ COIN_SUPPORTED: {}, COIN_AVAILABLE: {} }),
            getHubConfigFetchedAt: () => null
        },
        pools: {}
    };
}

async function readStatus(){
    const result = await statusReaders.getStatus.call(statusContext(), {});
    return result[0];
}

describe('hub consensus hash mismatch status reporting', function(){
    let connector;

    beforeEach(function(){
        connector = new XChainHubConnector([]);
        connector.checkHubConsensusHash(null);
    });

    it('records unknown, matching, and mismatching hash states', async function(){
        assert.strictEqual(connector.hubConsensusHashMismatch, null);
        assert.deepStrictEqual(connector.hubConsensusHashMismatchDetails, []);

        connector.checkHubConsensusHash(trueHashes());
        assert.strictEqual(connector.hubConsensusHashMismatch, false);
        assert.deepStrictEqual(connector.hubConsensusHashMismatchDetails, []);
        const matchingStatus = await readStatus();
        assert.strictEqual(matchingStatus.hub_consensus_hash_mismatch, false);
        assert.deepStrictEqual(matchingStatus.hub_consensus_hash_mismatch_details, []);

        const drifted = trueHashes();
        drifted.testnet = Object.assign({}, drifted.testnet, { BTC: 'f'.repeat(64) });
        connector.checkHubConsensusHash(drifted);
        assert.strictEqual(connector.hubConsensusHashMismatch, true);
        assert.deepStrictEqual(connector.hubConsensusHashMismatchDetails, [
            'BTC/testnet: hub ' + 'f'.repeat(64) + ' vs bundled ' + trueHashes().testnet.BTC
        ]);
    });

    it('publishes unknown as the final two status keys', async function(){
        const status = await readStatus();
        assert.strictEqual(status.hub_consensus_hash_mismatch, null);
        assert.deepStrictEqual(status.hub_consensus_hash_mismatch_details, []);
        assert.deepStrictEqual(Object.keys(status).slice(-2), [
            'hub_consensus_hash_mismatch', 'hub_consensus_hash_mismatch_details'
        ]);
    });

    it('publishes mismatch details without changing existing status fields', async function(){
        const drifted = trueHashes();
        drifted.regtest = Object.assign({}, drifted.regtest, { LTC: 'e'.repeat(64) });
        connector.checkHubConsensusHash(drifted);
        const unrelated = new XChainHubConnector([]);
        assert.strictEqual(unrelated.hubConsensusHashMismatch, null);

        const status = await readStatus();
        assert.deepStrictEqual(status.supported, {});
        assert.deepStrictEqual(status.available, {});
        assert.strictEqual(status.hub_consensus_hash_mismatch, true);
        assert.strictEqual(status.hub_consensus_hash_mismatch_details.length, 1);
        assert.match(status.hub_consensus_hash_mismatch_details[0], /^LTC\/regtest:/);
        assert.deepStrictEqual(Object.keys(status).slice(-2), [
            'hub_consensus_hash_mismatch', 'hub_consensus_hash_mismatch_details'
        ]);
    });
});

describe('hub consensus hash compared flag', function(){
    let connector;

    beforeEach(function(){
        connector = new XChainHubConnector([]);
    });

    it('reports unknown when the hub served no hash for any bundled coin', function(){
        connector.checkHubConsensusHash(trueHashes());
        assert.strictEqual(connector.hubConsensusHashMismatch, false);

        connector.checkHubConsensusHash({ mainnet: {}, testnet: { UNBUNDLED: 'a'.repeat(64) } });
        assert.strictEqual(connector.hubConsensusHashMismatch, null);
        assert.deepStrictEqual(connector.hubConsensusHashMismatchDetails, []);

        connector.checkHubConsensusHash({});
        assert.strictEqual(connector.hubConsensusHashMismatch, null);
    });
});
