'use strict';

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
 * REST lookup keys are checked before a database read: transaction hashes
 * have their wire shape, address filters belong to the selected coin and
 * network, and compact ticker ids use a plain safe decimal integer.
 */

const { expect } = require('chai');
const Utility = require('../../../../src/lib/utility.js');
const { validateParams } = require('../../../../src/explorer/request/validate_params.js');
const { getFullConfig, createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { base58check } = require('./address_shape.test/support/address_encode.js');

const util = new Utility(createConfigInfoStub());
const BTC_ADDRESS = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';
const BTC_BAD_CHECKSUM = BTC_ADDRESS.slice(0, -1) + 'w';
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const LTC_ADDRESS = 'LLnCCHbSzfwWquEdaS5TF2Yt7uz5Qb1SZ1';
const DOGE_ADDRESS = base58check(30, Buffer.alloc(20, 0x33));
const TESTNET_ADDRESS = base58check(111, Buffer.alloc(20, 0x44));
const HASH = 'ab'.repeat(32);
const SYNTHETIC_HASHES = [
    ['BTC',  'GENESIS-BTC-P1-' + '01'.repeat(24)],
    ['BTC',  'GENESIS-BTC-P2-' + '12'.repeat(24)],
    ['LTC',  'GENESIS-LTC-A-' + 'a2'.repeat(24)],
    ['BTC',  'GENESIS-BTC-GAS-' + 'b4'.repeat(24)],
    ['DOGE', 'XPOLICY-' + 'f3'.repeat(24)],
    ['LTC',  'XBRIDGE-LTC-GAS-' + 'b5'.repeat(24)],
    ['LTC',  'XBRIDGE-LTC-BRIDGE-' + 'c5'.repeat(24)],
    ['LTC',  'XBRIDGE-LTC-BRIDGEDEC-' + 'c6'.repeat(24)],
    ['DOGE', 'LIST_SHARE-' + 'd6'.repeat(24)]
];

function settle(method, type, search, coin = 'BTC'){
    const explorer = { util, mirrorGate: () => ({ blocked: false }) };
    const st = {
        config: getFullConfig(),
        cfg: { coin, type: 'api', data: { method, type, search } },
        response: {}
    };
    return { settled: validateParams(explorer, st), st };
}

describe('REST transaction hash validation', function(){
    it('accepts one 32-byte hexadecimal hash and canonicalizes its case', function(){
        for(const hash of [HASH, HASH.toUpperCase()]){
            const { settled, st } = settle('getTransaction', 'tx_hash', hash);
            expect(settled).to.equal(false);
            expect(st.cfg.data.search).to.equal(HASH);
        }
    });

    it('accepts the synthetic transaction hashes persisted by the indexer without changing case', function(){
        for(const [coin, hash] of SYNTHETIC_HASHES){
            const { settled, st } = settle('getTransaction', 'tx_hash', hash, coin);
            expect(settled, hash).to.equal(false);
            expect(st.cfg.data.search).to.equal(hash);
        }
    });

    it('refuses malformed hashes with a stable 400', function(){
        for(const hash of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
            'GENESIS-BTC-P1-' + 'a'.repeat(47),
            'GENESIS-BTC-P0-' + 'a'.repeat(48),
            'GENESIS-BTC-P3-' + 'a'.repeat(48),
            'GENESIS-BTC-PX-' + 'a'.repeat(48),
            'GENESIS-BTC-A-' + 'g'.repeat(48),
            'GENESIS-btc-A-' + 'a'.repeat(48),
            'XPOLICY-' + 'A'.repeat(48),
            'XPOLICY-' + 'a'.repeat(49),
            'XBRIDGE-BTC-OTHER-' + 'a'.repeat(48),
            'LIST_SHARE-' + 'a'.repeat(47), ['a', 'b']]){
            const { settled, st } = settle('getTransaction', 'tx_hash', hash);
            expect(settled, JSON.stringify(hash)).to.equal(true);
            expect(st.response.code).to.equal(400);
            expect(st.response.json.code).to.equal('INVALID_TX_HASH');
        }
    });
});

describe('REST ticker reference validation', function(){
    it('accepts ticker text and a compact safe decimal id', function(){
        for(const tick of ['xchain', '$$$$$$$$$$$78324%@##*(@#', '^0', '^123'])
            expect(settle('getToken', 'token', tick).settled, tick).to.equal(false);
        const compact = settle('getToken', 'token', '^000123');
        expect(compact.settled).to.equal(false);
        expect(compact.st.cfg.data.search).to.equal('^123');
    });

    it('refuses a malformed compact id instead of coercing it to another ticker id', function(){
        for(const tick of ['^', '^^1', '^-1', '^1.5', '^1e3', '^0x10', '^9007199254740992']){
            const { settled, st } = settle('getToken', 'token', tick);
            expect(settled, tick).to.equal(true);
            expect(st.response.code).to.equal(400);
            expect(st.response.json.code).to.equal('INVALID_TICK_REF');
        }
    });
});

describe('REST address validation', function(){
    it('accepts a checksummed address for the selected coin', function(){
        expect(settle('getAddress', 'address', BTC_ADDRESS).settled).to.equal(false);
        const upper = settle('getAddress', 'address', BTC_BECH32.toUpperCase());
        expect(upper.settled).to.equal(false);
        expect(upper.st.cfg.data.search).to.equal(BTC_BECH32);
        const contract = settle('getAddress', 'address', 'C:BTC:7');
        expect(contract.settled).to.equal(false);
        expect(contract.st.cfg.data.search).to.equal('C:BTC:7');
    });

    it('accepts contract addresses from another configured chain', function(){
        const execution = settle('getExecutions', 'address', 'C:BTC:500', 'LTC');
        expect(execution.settled).to.equal(false);
        expect(execution.st.cfg.data.search).to.equal('C:BTC:500');

        const message = settle('getMessages', 'source', 'C:DOGE:42', 'BTC');
        expect(message.settled).to.equal(false);
        expect(message.st.cfg.data.search).to.equal('C:DOGE:42');
    });

    it('accepts every mirrored chain address on the oracle price route', function(){
        for(const address of [BTC_ADDRESS, LTC_ADDRESS, DOGE_ADDRESS]){
            const oracle = settle('getOraclePrices', 'address', address, 'BTC');
            expect(oracle.settled, address).to.equal(false);
            expect(oracle.st.cfg.data.search).to.equal(address);
        }
    });

    it('uses the selected network while accepting all mirrored oracle chains', function(){
        expect(settle('getOraclePrices', 'address', TESTNET_ADDRESS, 'TBTC').settled).to.equal(false);
        const wrongNetwork = settle('getOraclePrices', 'address', BTC_ADDRESS, 'TBTC');
        expect(wrongNetwork.settled).to.equal(true);
        expect(wrongNetwork.st.response.json.code).to.equal('INVALID_ADDRESS');
    });

    it('refuses malformed, wrong-network and bad-checksum addresses before the read', function(){
        const wrongNetwork = 'bcrt1qqurswpc8qurswpc8qurswpc8qurswpc8m9e9c7';
        for(const address of ['not-an-address', BTC_BAD_CHECKSUM, wrongNetwork, 'C:ZZZ:7',
            'C:btc:7', 'C:BTC:007', 'C:BTC:1e3', 'C:BTC:9007199254740992']){
            const { settled, st } = settle('getAddress', 'address', address);
            expect(settled, address).to.equal(true);
            expect(st.response.code).to.equal(400);
            expect(st.response.json.code).to.equal('INVALID_ADDRESS');
        }
    });
});

describe('REST cross-chain address lanes', function(){
    it('accepts another chain address on lanes that store cross-chain destinations', function(){
        const lanes = [['getMessages', 'destination'], ['getMessages', 'address'],
            ['getSwapMatches', 'address'], ['getXbridges', 'address']];
        for(const [method, type] of lanes){
            for(const [coin, address] of [['BTC', LTC_ADDRESS], ['DOGE', BTC_ADDRESS], ['LTC', DOGE_ADDRESS]]){
                const { settled, st } = settle(method, type, address, coin);
                expect(settled, method + ' ' + type + ' ' + coin).to.equal(false);
                expect(st.cfg.data.search).to.equal(address);
            }
            const wrongNetwork = settle(method, type, TESTNET_ADDRESS, 'BTC');
            expect(wrongNetwork.settled, method + ' ' + type).to.equal(true);
            expect(wrongNetwork.st.response.json.code).to.equal('INVALID_ADDRESS');
        }
    });
});
