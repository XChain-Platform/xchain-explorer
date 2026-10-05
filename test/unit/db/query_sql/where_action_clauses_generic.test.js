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
const { genericClause } = require('../../../../src/db/query_sql/where_action_clauses.js');

function build(method, type, sql = 'WHERE anchor') {
    return genericClause({}, { data: { method, type } }, sql);
}

describe('genericClause address and block lanes', function(){
    it('uses both action addresses for methods with two address roles', function(){
        const methods = [
            'getMessages', 'getMints', 'getOrders', 'getSends',
            'getSweeps', 'getDispensers', 'getDispenses'
        ];

        for (const method of methods)
            assert.strictEqual(build(method, 'address'), 'WHERE anchor AND (a2.address=? OR a3.address=?)');
    });

    it('uses the method-specific or default address aliases', function(){
        assert.strictEqual(
            build('getCoinpayObligations', 'address'),
            'WHERE anchor AND (a1.address=? OR a2.address=?)'
        );
        assert.strictEqual(build('getDelegations', 'address'), 'WHERE anchor AND a2.address=?');
    });

    it('uses the direct coinpay block column and the default block join', function(){
        assert.strictEqual(
            build('getCoinpayObligations', 'block'),
            'WHERE anchor AND m.block_index=?'
        );
        assert.strictEqual(build('getMessages', 'block'), 'WHERE anchor AND b1.block_index=?');
    });

    it('appends the destination and source address predicates', function(){
        assert.strictEqual(build('getMessages', 'destination'), 'WHERE anchor AND a3.address=?');
        assert.strictEqual(build('getMessages', 'source'), 'WHERE anchor AND a2.address=?');
    });
});

describe('genericClause scoped lanes', function(){
    it('limits the pubkey predicate to delegations', function(){
        assert.strictEqual(build('getDelegations', 'pubkey'), 'WHERE anchor AND a3.pubkey=?');
        assert.strictEqual(build('getMessages', 'pubkey'), 'WHERE anchor');
    });

    it('limits the oracle predicate to dispensers', function(){
        const fragment = ' AND m.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)';
        assert.strictEqual(build('getDispensers', 'oracle'), `WHERE anchor${fragment}`);
        assert.strictEqual(build('getDispenses', 'oracle'), 'WHERE anchor');
    });

    it('limits the dispenser predicate to dispenses', function(){
        assert.strictEqual(
            build('getDispenses', 'dispenser'),
            'WHERE anchor AND m.dispenser_action_index=?'
        );
        assert.strictEqual(build('getDispensers', 'dispenser'), 'WHERE anchor');
    });
});

describe('genericClause entity lanes', function(){
    it('uses target contract indexes for contract relationship methods', function(){
        const methods = [
            'getContractStakes', 'getContractUnstakes',
            'getContractDelegations', 'getSlashEvents'
        ];

        for (const method of methods)
            assert.strictEqual(build(method, 'contract'), 'WHERE anchor AND m.target_contract_index=?');
    });

    it('uses the remaining method-specific contract predicates', function(){
        assert.strictEqual(build('getContract', 'contract'), 'WHERE anchor AND m.action_index=?');
        assert.strictEqual(build('getContractState', 'contract'), 'WHERE anchor');
        assert.strictEqual(build('getContracts', 'contract'), 'WHERE anchor AND m.contract_index=?');
    });

    it('uses the file-specific and default token predicates', function(){
        assert.strictEqual(build('getFiles', 'token'), 'WHERE anchor AND m.type_id=1 AND t4.tick=?');
        assert.strictEqual(build('getMessages', 'token'), 'WHERE anchor AND t3.tick=?');
    });

    it('limits the gate predicate to files', function(){
        assert.strictEqual(build('getFiles', 'gate'), 'WHERE anchor AND gf.gate_ticker=?');
        assert.strictEqual(build('getMessages', 'gate'), 'WHERE anchor');
    });

    it('uses the method-specific name predicates', function(){
        const search = ' AND MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)';
        assert.strictEqual(build('getFiles', 'name'), 'WHERE anchor AND m.name=?');
        assert.strictEqual(build('getContracts', 'name'), `WHERE anchor${search}`);
        assert.strictEqual(build('getMessages', 'name'), 'WHERE anchor');
    });

    it('returns incoming SQL unchanged for an unknown type', function(){
        assert.strictEqual(build('getMessages', 'unknown', 'custom sql'), 'custom sql');
    });
});
