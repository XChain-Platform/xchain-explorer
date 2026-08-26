'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Browser-side ADDRESS_PARAMS <-> canonical coins registry parity guard.
//
// src/content/js/xchain.js keeps a hand-maintained mirror of the per-chain base58
// version bytes and bech32 HRPs that isCryptoAddress() reads to decide which address
// shapes the search box accepts. consensus_pin.js hashes the bundled coins/*.js net
// objects, NOT this parallel table, so a one-sided edit (a DOGE prefix change in the
// coin bundle, say) moves the pin and every guarded consumer while this table keeps
// the old bytes, with nothing failing anywhere. The indexer, the wallet and the
// vanity tool all pin their copies this way; this was the last unguarded mirror.
//
// The browser file is a plain script that touches the DOM, so it can never be
// require()d here: the literal is extracted from the source text by brace matching
// and evaluated in isolation. It is static hex numbers, strings and nulls by
// construction.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const coins = require('../../src/coins');

// Overridable so the guard's own negative control can point it at a mutated copy;
// nothing in the repo sets it.
const SOURCE = process.env.XCHAIN_ADDRESS_PARAMS_SOURCE
    || path.resolve(__dirname, '../../src/content/js/xchain.js');

function extractAddressParams(){
    const src  = fs.readFileSync(SOURCE, 'utf8');
    const m    = /(?:var|const|let)\s+ADDRESS_PARAMS\s*=/.exec(src);
    assert.notStrictEqual(m, null,
        SOURCE + ' no longer declares ADDRESS_PARAMS; update or retire this guard');
    const open = src.indexOf('{', m.index);
    assert.notStrictEqual(open, -1, 'ADDRESS_PARAMS is no longer an object literal; update this guard');
    let depth = 0, end = -1;
    for(let i = open; i < src.length; i++){
        if(src[i] === '{') depth++;
        else if(src[i] === '}'){ depth--; if(depth === 0){ end = i; break; } }
    }
    assert.notStrictEqual(end, -1, 'could not brace-match the ADDRESS_PARAMS literal');
    return new Function('return (' + src.slice(open, end + 1) + ');')();
}

describe('ADDRESS_PARAMS parity with the consensus-pinned coins registry', function(){
    const PARAMS = extractAddressParams();

    it('covers exactly the allowed coins and networks', function(){
        assert.deepStrictEqual(Object.keys(PARAMS).sort(), [...coins.ALLOWED_COINS].sort(),
            'ADDRESS_PARAMS coin set drifted from coins.ALLOWED_COINS');
        for(const tick of coins.ALLOWED_COINS)
            assert.deepStrictEqual(Object.keys(PARAMS[tick]).sort(), [...coins.NETWORKS].sort(),
                'ADDRESS_PARAMS[' + tick + '] network set drifted from coins.NETWORKS');
    });

    // Iterating the registry rather than a hardcoded list means a coin added to
    // ALLOWED_COINS is covered here the day it lands, instead of silently skipped.
    for(const tick of coins.ALLOWED_COINS){
        for(const net of coins.NETWORKS){
            it(tick + '/' + net + ' base58 prefixes + HRP equal the canonical net object', function(){
                const canonical = coins.getCoinConfig(tick, net).net;
                const local     = PARAMS[tick] && PARAMS[tick][net];
                assert.ok(local, 'ADDRESS_PARAMS has no ' + tick + '/' + net + ' entry');
                assert.strictEqual(local.p2pkh, canonical.pubKeyHash,
                    tick + '/' + net + ' p2pkh drifted from coins/' + tick + '.js pubKeyHash');
                assert.strictEqual(local.p2sh, canonical.scriptHash,
                    tick + '/' + net + ' p2sh drifted from coins/' + tick + '.js scriptHash');
                // DOGE has no segwit: the canonical net omits bech32 and the local hrp is null.
                assert.strictEqual(local.hrp, canonical.bech32 === undefined ? null : canonical.bech32,
                    tick + '/' + net + ' hrp drifted from coins/' + tick + '.js bech32');
            });
        }
    }
});
