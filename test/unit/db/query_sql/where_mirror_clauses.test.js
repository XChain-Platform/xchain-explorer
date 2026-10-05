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
    MIRROR_CLAUSE_BUILDERS
} = require('../../../../src/db/query_sql/where_mirror_clauses.js');

const EXPECTED_METHODS = [
    'getSlashEvents', 'getCapabilitySlashEvents', 'getFullNodeVerifications',
    'getPriceSnapshots', 'getOraclePrices', 'getAttestValidatorStats',
    'getValidatorCapabilities', 'getCapabilitySnapshots',
    'getGovernanceProposals', 'getGovernanceVotes', 'getPeers',
    'getConsensusState', 'getConfigs', 'getTelemetryPings',
    'getCrossChainMatches', 'getCrossChainSettlements', 'getReorgs',
    'getSlashProposals', 'getEmissions', 'getXcalls', 'getAnchors',
    'getAnchorRewardAttestations', 'getCommitments', 'getXcall'
];

const TYPE_CASES = {
    getSlashEvents: [
        ['block', ' AND m.block_index=?'],
        ['contract', ' AND m.target_contract_index=?'],
        ['address', ` AND m.signing_pubkey_id IN (
                SELECT DISTINCT signing_pubkey_id FROM contract_stakes
                WHERE source_id = (SELECT id FROM index_addresses WHERE address=?)
            )`]
    ],
    getCapabilitySlashEvents: [
        ['block', ' AND m.block_index=?'],
        ['capability', ' AND m.capability=?'],
        ['pubkey', ' AND pk.pubkey=?'],
        ['address', ' AND sub.address=?']
    ],
    getFullNodeVerifications: [
        ['block', ' AND m.block_index=?'],
        ['epoch', ' AND m.epoch_height=?'],
        ['pubkey', ' AND pk.pubkey=?'],
        ['address', ' AND a3.address=?']
    ]
};

function build(method, type, sql = 'WHERE anchor') {
    return MIRROR_CLAUSE_BUILDERS[method](null, { data: { type } }, sql);
}

describe('MIRROR_CLAUSE_BUILDERS', function(){
    it('exports exactly the mirror query builders as functions', function(){
        const methods = Object.keys(MIRROR_CLAUSE_BUILDERS);

        assert.deepStrictEqual(methods.sort(), EXPECTED_METHODS.slice().sort());
        for (const method of methods)
            assert.strictEqual(typeof MIRROR_CLAUSE_BUILDERS[method], 'function');
    });

    for (const [method, cases] of Object.entries(TYPE_CASES)) {
        it(`${method} appends only the fragment selected by type`, function(){
            for (const [type, fragment] of cases)
                assert.strictEqual(build(method, type), `WHERE anchor${fragment}`);
        });
    }

    it('preserves SQL for unknown types in every builder', function(){
        for (const method of EXPECTED_METHODS)
            assert.strictEqual(build(method, 'unknown'), 'WHERE anchor');
    });
});
