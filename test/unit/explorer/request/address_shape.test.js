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
 * The server's address-shape check against the address page's own
 * isCryptoAddress: the page shows "No address in this URL" exactly when the
 * browser check fails, and the server answers that page 404 on its verdict, so
 * the two must agree on every input.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const { expect } = require('chai');

const { isCoinAddress } = require('../../../../src/explorer/request/address_shape.js');
const { getFullConfig } = require('../../../fixtures/mock-config.js');
const { extractBlock, extractFn } = require('../../../helpers/source_slice.js');
const { base58check, segwit } = require('./address_shape.test/support/address_encode.js');

const ROOT    = path.resolve(__dirname, '../../../..');
const SRC     = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/address_utils.js'), 'utf8');
const NULLSRC = fs.readFileSync(path.join(ROOT, 'src/content/js/formatters.js'), 'utf8');

// The browser check, run as the page runs it with XC naming one coin's chain and network.
function browserCheck(){
    const context = vm.createContext({ BigInt });
    vm.runInContext(extractFn(NULLSRC, 'isNull'), context);
    vm.runInContext(extractBlock(SRC, 'var ADDRESS_PARAMS') + ';', context);
    for(const name of ['base58DecodeAddress', 'bech32DecodeAddress', 'isCryptoAddress'])
        vm.runInContext(extractFn(SRC, name), context);
    return context;
}

const NETWORKS = { mainnet: '', testnet: 'T', regtest: 'R' };
const CHAINS   = ['BTC', 'LTC', 'DOGE'];

// Every version byte and HRP either side knows, so each coin is also tried with
// the other coins' addresses.
function corpus(context){
    const hash20 = Buffer.alloc(20, 0x11);
    const hash32 = Buffer.alloc(32, 0x22);
    const out = ['', 'notanaddress', '^123', '1', 'deadbeef', 'x'.repeat(60)];
    const bytes = new Set();
    const hrps  = new Set(['dgb', 'doge']);
    for(const chain of CHAINS)
        for(const network of Object.keys(NETWORKS)){
            const p = context.ADDRESS_PARAMS[chain][network];
            bytes.add(p.p2pkh); bytes.add(p.p2sh);
            if(p.hrp) hrps.add(p.hrp);
        }
    for(const byte of bytes){
        const good = base58check(byte, hash20);
        out.push(good, good.slice(0, -1) + (good.slice(-1) === 'z' ? 'y' : 'z'), good + '1', '0' + good.slice(1));
        out.push(base58check(byte, Buffer.alloc(21, 0x33)));
    }
    for(const hrp of hrps){
        const v0 = segwit(hrp, 0, hash20);
        out.push(v0, v0.toUpperCase(), v0[0].toUpperCase() + v0.slice(1), segwit(hrp, 0, hash32), segwit(hrp, 1, hash32));
        out.push(segwit(hrp, 0, Buffer.alloc(24, 1)), v0.slice(0, -1) + (v0.slice(-1) === 'q' ? 'p' : 'q'));
    }
    return out;
}

describe('server address shape agrees with the address page', function () {
    const context = browserCheck();
    const cfg     = getFullConfig();
    const inputs  = corpus(context);

    it('builds the BIP-173 reference address from its encoder', function () {
        const program = Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
        expect(segwit('bc', 0, program)).to.equal('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    });

    for(const chain of CHAINS)
        for(const [network, prefix] of Object.entries(NETWORKS)){
            const code = prefix + chain;
            it(code + ' returns the browser verdict on every corpus input', function () {
                let accepted = 0;
                for(const input of inputs){
                    const expected = context.isCryptoAddress(input, chain, network);
                    expect(isCoinAddress(cfg, code, input), code + ' ' + JSON.stringify(input)).to.equal(expected);
                    if(expected) accepted++;
                }
                // Each coin accepts its own P2PKH and P2SH at least, so the corpus is not all rejects.
                expect(accepted).to.be.at.least(2);
            });
        }

    it('answers null for a coin code the config does not name', function () {
        expect(isCoinAddress(cfg, 'ZZZ', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev')).to.equal(null);
    });
});
