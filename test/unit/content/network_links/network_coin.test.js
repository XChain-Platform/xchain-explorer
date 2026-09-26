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
 * networkCoin: the one rule every coin-built explorer URL follows.
 *
 * The API returns chain symbols bare (a TDOGE action's market legs read
 * give_coin "DOGE"), and a bare symbol is the mainnet namespace, so a
 * testnet page that spliced one into a path linked its reader to mainnet.
 * These cases pin the mapping over every chain on every network, for bare
 * and already-namespaced input, and pin that a mainnet page stays
 * unprefixed. The last block guards the source: a URL path built from a
 * coin value that is not the page's own must go through networkCoin.
 */

'use strict';

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const NC      = require('../../../../src/content/js/network_coin.js');
const F       = require('../../../../src/content/js/formatters.js');
const CONTENT = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content');

const CHAINS   = ['BTC', 'LTC', 'DOGE'];
const PREFIXES = { mainnet: '', testnet: 'T', regtest: 'R' };

// Run fn with a page XC in place, restoring whatever the process had.
function onPage(xc, fn){
    const had = Object.prototype.hasOwnProperty.call(global, 'XC'), prev = global.XC;
    global.XC = xc;
    try { return fn(); } finally { if(had) global.XC = prev; else delete global.XC; }
}

describe('networkCoin: every chain on every network', function () {
    for(const [network, prefix] of Object.entries(PREFIXES)){
        for(const pageChain of CHAINS){
            const page = prefix + pageChain;
            it('a ' + page + ' page maps bare and namespaced legs onto ' + (prefix || 'no') + ' prefix', function () {
                onPage({ coin: page, network: network }, () => {
                    for(const leg of CHAINS){
                        const want = prefix + leg;
                        for(const input of [leg, 'T' + leg, 'R' + leg, leg.toLowerCase(), ('t' + leg).toLowerCase()])
                            assert.equal(NC.networkCoin(input), want, page + ' page, input ' + input);
                    }
                });
            });
        }
    }

    it('reads the page maps when xchain.js has loaded them, not only the literals', function () {
        const xc = { coin: 'RLTC', chains: { BTC: 'Bitcoin', LTC: 'Litecoin', DOGE: 'Dogecoin' },
                     networks: { mainnet: '', testnet: 'T', regtest: 'R' } };
        onPage(xc, () => {
            assert.equal(NC.networkCoin('DOGE'), 'RDOGE');
            assert.equal(NC.networkCoin('TBTC'), 'RBTC');
        });
    });

    it('a mainnet page stays unprefixed, even for a leg handed over namespaced', function () {
        onPage({ coin: 'DOGE', network: 'mainnet' }, () => {
            assert.equal(NC.networkCoin('TDOGE'), 'DOGE');
            assert.equal(NC.networkCoin('RBTC'), 'BTC');
            assert.equal(NC.networkCoin('LTC'), 'LTC');
        });
    });
});

describe('networkCoin: values that name no chain', function () {
    it('falls back to the page coin for an absent or unknown value', function () {
        onPage({ coin: 'TDOGE' }, () => {
            for(const v of [null, undefined, '', 'ETH', 'XBTC', 'TTBTC'])
                assert.equal(NC.networkCoin(v), 'TDOGE', 'input ' + String(v));
        });
    });

    it('with no page coin, keeps a recognised value in its own namespace', function () {
        onPage(undefined, () => {
            assert.equal(NC.networkCoin('TBTC'), 'TBTC');
            assert.equal(NC.networkCoin('doge'), 'DOGE');
        });
    });

    it('parses a namespace into its chain and prefix, and refuses anything else', function () {
        onPage(undefined, () => {
            assert.deepEqual(NC.parseNetworkCoin('rltc'), { chain: 'LTC', prefix: 'R' });
            assert.deepEqual(NC.parseNetworkCoin('DOGE'), { chain: 'DOGE', prefix: '' });
            assert.equal(NC.parseNetworkCoin('ETH'), null);
            assert.equal(NC.parseNetworkCoin(null), null);
        });
    });
});

describe('tokenUrl maps its coin through networkCoin', function () {
    it('links the reported TDOGE market legs under /TDOGE/, not mainnet /DOGE/', function () {
        onPage({ coin: 'TDOGE', network: 'testnet' }, () => {
            assert.equal(F.tokenUrl('DOGE', 'XCHAIN'), '/TDOGE/token/XCHAIN');
            assert.equal(F.tokenUrl('BTC', 'XCHAIN'), '/TBTC/token/XCHAIN');
            assert.equal(F.tokenUrl(null, 'XCHAIN'), '/TDOGE/token/XCHAIN');
        });
    });

    it('keeps a mainnet page on mainnet', function () {
        onPage({ coin: 'LTC', network: 'mainnet' }, () => {
            assert.equal(F.tokenUrl('DOGE', 'PEPE'), '/DOGE/token/PEPE');
            assert.equal(F.tokenUrl('LTC', 'PEPE'), '/LTC/token/PEPE');
        });
    });
});

// Every client script and page, as the browser gets them (vendored bundles aside).
function clientFiles(){
    const out = [];
    const walk = (dir) => {
        for(const e of fs.readdirSync(dir, { withFileTypes: true })){
            const full = path.join(dir, e.name);
            if(e.isDirectory()) walk(full);
            else if(/\.(js|html)$/.test(e.name) && !/(\.min\.|swagger|jquery|bootstrap|chart|numeral|moment)/.test(e.name))
                out.push(full);
        }
    };
    ['js', 'html', 'components'].forEach((d) => walk(path.join(CONTENT, d)));
    return out;
}

// The first path segment of '/' + X + '/route/' (or href="/' + X + '/route/').
const PATH_BUILD = /(?:'\/'|"\/')\s*\+\s*(.+?)\s*\+\s*'\/(?:token|action|address|block|contract|market|transaction|dispenser|checkpoint|anchor|execution|bet_feed|governance_votes|api|explorer)\b/g;
// XC.coin is the page's own namespace, and `coin` / anchorCoin() are the page coin
// by convention (the datatable context, getActionDetails, the renderers' locals).
// actCoin is token_info.js's networkCoin result, spliced twice. Anything else has to
// be a networkCoin(...) call.
const PAGE_COIN = /^(XC\.coin|coin|anchorCoin\(\)|actCoin)$/;
const MAPPED    = /^(xbEsc\()?networkCoin\(/;

describe('source guard: a coin-built path goes through networkCoin', function () {
    it('no client path splices a data coin (give_coin, coin1, target_chain, origin...) raw', function () {
        const offenders = [];
        for(const file of clientFiles()){
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                for(const m of line.matchAll(PATH_BUILD)){
                    if(!PAGE_COIN.test(m[1]) && !MAPPED.test(m[1]))
                        offenders.push(path.relative(CONTENT, file) + ':' + (i + 1) + ' ' + m[1]);
                }
            });
        }
        assert.deepEqual(offenders, [], 'route these through networkCoin:\n' + offenders.join('\n'));
    });

    it('the page loads network_coin.js ahead of formatters.js', function () {
        const shell = fs.readFileSync(path.join(CONTENT, 'html', 'template.html'), 'utf8');
        const nc = shell.indexOf('src="/js/network_coin.js"'), fm = shell.indexOf('src="/js/formatters.js"');
        assert.ok(nc > 0, 'template.html does not load network_coin.js');
        assert.ok(nc < fm, 'network_coin.js must load before formatters.js, which calls it');
    });
});
