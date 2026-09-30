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
 * network_coin.js
 *
 * The one rule every coin-built explorer URL follows: a link keeps the
 * network of the page it is on. The API returns chain symbols bare (a
 * TDOGE action's market legs read give_coin "DOGE"), and a bare symbol is
 * the MAINNET path, so splicing one into '/' + coin + '/token/...' sent a
 * testnet reader to mainnet. networkCoin takes the chain from the value
 * and the network from the page, so a cross-chain leg still lands on its
 * own chain (a TDOGE page's BTC leg is /TBTC/) and never leaves the
 * page's network. Loaded before formatters.js, which builds on it.
 */

// Split a namespace ('TDOGE') or a bare chain symbol ('DOGE') into its chain and
// network prefix, or null when it names no supported chain. Case-insensitive,
// because the value may come from on-chain text ('action:doge:12').
function parseNetworkCoin(value){
    if(value === null || value === undefined) return null;
    // The page's XC.chains / XC.networks maps spell the namespaces; the literals
    // stand in when they are absent (a unit harness, or a caller ahead of xchain.js).
    var xc       = (typeof XC !== 'undefined' && XC) ? XC : {};
    var chains   = xc.chains ? Object.keys(xc.chains) : ['BTC', 'LTC', 'DOGE'];
    var prefixes = xc.networks || { mainnet: '', testnet: 'T', regtest: 'R' };
    var upper    = String(value).toUpperCase();
    for(var i = 0; i < chains.length; i++){
        for(var network in prefixes){
            // Mainnet's prefix is '' by design, so 'BTC' parses as mainnet BTC.
            if(upper === String(prefixes[network] + chains[i]).toUpperCase())
                return { chain: String(chains[i]).toUpperCase(), prefix: String(prefixes[network]) };
        }
    }
    return null;
}

// The URL namespace `coin` lives under on THIS page's network: its own chain,
// the page's prefix. Bare or already namespaced input both work ('BTC', 'TBTC'
// and 'RBTC' all give TBTC on a testnet page). A value naming no supported
// chain (null, a typo) falls back to the page coin. With no page coin at all,
// a recognised value keeps its own namespace and anything else passes through.
function networkCoin(coin){
    var pageCoin = (typeof XC !== 'undefined' && XC && XC.coin) ? XC.coin : null;
    var page     = parseNetworkCoin(pageCoin);
    var leg      = parseNetworkCoin(coin);
    if(!page)
        return leg ? leg.prefix + leg.chain : (pageCoin || coin);
    return leg ? page.prefix + leg.chain : page.prefix + page.chain;
}

// Node (the unit suites) requires this file; the browser keeps the globals above.
if(typeof module !== 'undefined' && module.exports)
    module.exports = { networkCoin: networkCoin, parseNetworkCoin: parseNetworkCoin };
