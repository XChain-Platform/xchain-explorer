/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * owner_withdraw: the derived flag every contract response carries so a
 * wallet can tell whether the deployer can still pull tokens out
 * (OWNER_WITHDRAW_OPT_IN). The cases are the indexer's rule restated: a
 * contract deployed before the instant keeps owner WITHDRAW, one deployed at
 * or after it has it only when its stored meta declares ownerWithdraw: true,
 * and anything the explorer cannot judge is served as null, never guessed.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const {
    OWNER_WITHDRAW_OPT_IN_KEY,
    declaresOwnerWithdraw,
    activationTime,
    ownerWithdrawState,
    attachOwnerWithdraw,
    resolveContractNetwork
} = require('../../../src/contract/owner_withdraw.js');
const { applyPostPasses } = require('../../../src/db/query_sql/data_post.js');
const { formatOwnerWithdraw } = require('../../../src/content/js/formatters/protocol.js');

const TESTNET_INSTANT = 1790492400;
const OPTED_IN   = JSON.stringify({ name: 'Vault', version: '1.0.0', ownerWithdraw: true });
const UNDECLARED = JSON.stringify({ name: 'Pool', version: '1.0.0' });

describe('owner_withdraw: the activation row', function(){

    it('registers the indexer instants: mainnet unarmed, testnet at the cut, regtest genesis', function(){
        expect(gateRegistry.get(OWNER_WITHDRAW_OPT_IN_KEY)).to.deep.equal({
            mainnet: gateRegistry.UNARMED,
            testnet: TESTNET_INSTANT,
            regtest: 0
        });
    });

    it('answers no instant for a network the row does not carry', function(){
        expect(activationTime('signet')).to.equal(null);
        expect(activationTime(null)).to.equal(null);
        expect(activationTime('constructor')).to.equal(null);
    });
});

describe('owner_withdraw: declaresOwnerWithdraw', function(){

    it('opts in only on the boolean true', function(){
        expect(declaresOwnerWithdraw(OPTED_IN)).to.equal(true);
        expect(declaresOwnerWithdraw(JSON.stringify({ ownerWithdraw: false }))).to.equal(false);
        expect(declaresOwnerWithdraw(JSON.stringify({ ownerWithdraw: 'true' }))).to.equal(false);
        expect(declaresOwnerWithdraw(JSON.stringify({ ownerWithdraw: 1 }))).to.equal(false);
        expect(declaresOwnerWithdraw(UNDECLARED)).to.equal(false);
    });

    it('reads null, garbled, array and scalar meta_json as not opted in', function(){
        expect(declaresOwnerWithdraw(null)).to.equal(false);
        expect(declaresOwnerWithdraw(undefined)).to.equal(false);
        expect(declaresOwnerWithdraw('{"ownerWithdraw": tru')).to.equal(false);
        expect(declaresOwnerWithdraw('[true]')).to.equal(false);
        expect(declaresOwnerWithdraw('true')).to.equal(false);
        expect(declaresOwnerWithdraw('null')).to.equal(false);
    });
});

describe('owner_withdraw: ownerWithdrawState', function(){

    it('allows a contract deployed before the activation, declared or not', function(){
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: TESTNET_INSTANT - 1, network: 'testnet' })).to.equal(true);
        expect(ownerWithdrawState({ metaJson: null, blockTime: TESTNET_INSTANT - 1, network: 'testnet' })).to.equal(true);
    });

    it('allows an opted-in contract deployed after the activation', function(){
        expect(ownerWithdrawState({ metaJson: OPTED_IN, blockTime: TESTNET_INSTANT + 100, network: 'testnet' })).to.equal(true);
    });

    it('refuses an undeclared contract deployed at or after the activation', function(){
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: TESTNET_INSTANT, network: 'testnet' })).to.equal(false);
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: TESTNET_INSTANT + 100, network: 'testnet' })).to.equal(false);
    });

    it('refuses a post-activation contract whose meta_json is null or garbled', function(){
        expect(ownerWithdrawState({ metaJson: null, blockTime: TESTNET_INSTANT + 1, network: 'testnet' })).to.equal(false);
        expect(ownerWithdrawState({ metaJson: '{not json', blockTime: TESTNET_INSTANT + 1, network: 'testnet' })).to.equal(false);
        expect(ownerWithdrawState({ metaJson: JSON.stringify({ ownerWithdraw: 'true' }), blockTime: TESTNET_INSTANT + 1, network: 'testnet' })).to.equal(false);
    });

    it('keeps every mainnet contract withdrawable while the row ships unarmed', function(){
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: 1900000000, network: 'mainnet' })).to.equal(true);
    });
});

describe('owner_withdraw: ownerWithdrawState on regtest and unusable inputs', function(){

    it('refuses an undeclared regtest contract from genesis by default', function(){
        const prior = process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME;
        delete process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME;
        try {
            expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: 1, network: 'regtest' })).to.equal(false);
        } finally {
            if(prior !== undefined) process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME = prior;
        }
    });

    it('applies the regtest override the way the indexer parses it', function(){
        const prior = process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME;
        process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME = '2000000000';
        try {
            expect(activationTime('regtest')).to.equal(2000000000);
            expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: 1999999999, network: 'regtest' })).to.equal(true);
            expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: 2000000000, network: 'regtest' })).to.equal(false);
            process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME = 'garbage';
            expect(activationTime('regtest')).to.equal(0);
        } finally {
            if(prior === undefined) delete process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME;
            else process.env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME = prior;
        }
    });

    it('serves unknown (null) for an unresolved network or an unusable block time', function(){
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: TESTNET_INSTANT, network: null })).to.equal(null);
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: null, network: 'testnet' })).to.equal(null);
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: 'soon', network: 'testnet' })).to.equal(null);
    });

    it('still answers true for an opted-in contract when the network is unresolved', function(){
        expect(ownerWithdrawState({ metaJson: OPTED_IN, blockTime: null, network: null })).to.equal(true);
    });

    it('reads the driver BIGINT block_time', function(){
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: BigInt(TESTNET_INSTANT - 1), network: 'testnet' })).to.equal(true);
        expect(ownerWithdrawState({ metaJson: UNDECLARED, blockTime: BigInt(TESTNET_INSTANT), network: 'testnet' })).to.equal(false);
    });
});

describe('owner_withdraw: the contract responses', function(){

    // resolveCoinNetwork's contract: { coin, network } for a configured route
    // code, null for none, and it may throw while configuration is unavailable.
    function fakeDb(resolve){
        return {
            resolveCoinNetwork: async () => resolve(),
            attachContractMeta(row){ row.meta = row.meta_json ? JSON.parse(row.meta_json) : null; delete row.meta_json; return row; }
        };
    }

    it('attachOwnerWithdraw reads meta_json and the DEPLOY block time off the row', function(){
        const row = attachOwnerWithdraw({ meta_json: UNDECLARED, timestamp: TESTNET_INSTANT + 5 }, 'testnet');
        expect(row.owner_withdraw).to.equal(false);
        expect(row.meta_json).to.equal(UNDECLARED);
    });

    it('resolveContractNetwork serves null when the route code resolves to nothing or throws', async function(){
        expect(await resolveContractNetwork(fakeDb(() => ({ coin: 'DOGE', network: 'testnet' })), {})).to.equal('testnet');
        expect(await resolveContractNetwork(fakeDb(() => null), {})).to.equal(null);
        expect(await resolveContractNetwork(fakeDb(() => { throw new Error('config down'); }), {})).to.equal(null);
    });

    it('the getContracts post-pass sets owner_withdraw on every row before meta_json is parsed away', async function(){
        const db = fakeDb(() => ({ coin: 'DOGE', network: 'testnet' }));
        const rows = [
            { meta_json: UNDECLARED, timestamp: TESTNET_INSTANT - 1 },
            { meta_json: UNDECLARED, timestamp: TESTNET_INSTANT + 1 },
            { meta_json: OPTED_IN,   timestamp: TESTNET_INSTANT + 1 },
            { meta_json: null,       timestamp: TESTNET_INSTANT + 1 }
        ];
        await applyPostPasses(db, { data: { method: 'getContracts' } }, rows);
        expect(rows.map((r) => r.owner_withdraw)).to.deep.equal([true, false, true, false]);
        expect(rows.every((r) => !('meta_json' in r))).to.equal(true);
    });
});

describe('owner_withdraw: the contract page cell', function(){

    it('labels the three answers without guessing an absent one', function(){
        expect(formatOwnerWithdraw(true)).to.include('Allowed');
        expect(formatOwnerWithdraw(true)).to.include('can withdraw tokens this contract holds at any time');
        expect(formatOwnerWithdraw(false)).to.include('Not allowed');
        expect(formatOwnerWithdraw(null)).to.include('Unknown');
        expect(formatOwnerWithdraw(undefined)).to.include('Unknown');
        expect(formatOwnerWithdraw('true')).to.include('Unknown');
    });
});
