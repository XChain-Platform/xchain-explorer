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
 *
 * XChain Explorer - the LIST item gates /api/status publishes
 *
 * Whether an address LIST (TYPE=2) accepts any configured coin's address at the
 * coin's current tip. The indexer widens address items to every configured coin
 * under TOKEN_POLICY_INHERITANCE_ACTIVATION, a registry row read by its literal
 * key (the <COIN>:<network> slot wins over the bare network slot). A wallet
 * composing a LIST create or fork reads this flag before it accepts an
 * other-coin address, so it never sells an item the chain would refuse.
 *
 * A helper module rather than a reader part: it reads no database, only the
 * tip height status.js has already measured.
 *
 ********************************************************************/

'use strict';

const TOKEN_POLICY_INHERITANCE_KEY = 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION';

// Route code (BTC / TBTC / RDOGE) to { coin, network } against the loaded
// config, prefixed networks first so 'TBTC' is not read as a mainnet coin.
function routeCoinNetwork(coinConfigs, code){
    let prefixes = coinConfigs['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
    let networks = coinConfigs['COIN_NETWORKS'] || {};
    code = String(code || '').toUpperCase();
    for(let network in prefixes){
        let p = prefixes[network];
        if(p && code.startsWith(p) && networks[code.slice(p.length)]) return { coin: code.slice(p.length), network };
    }
    return networks[code] ? { coin: code, network: 'mainnet' } : null;
}

// True when address LIST items accept any configured coin at this tip. An
// unknown tip or an unresolvable route code reads false, the strict side, so a
// consumer that sees anything but true keeps other-coin addresses out.
function listAnyCoinItemsAtTip(coinConfigs, code, tip){
    let resolved = routeCoinNetwork(coinConfigs || {}, code);
    if(!resolved || !Number.isInteger(tip)) return false;
    try {
        // Required at the call: the registry loads the db readers, so a top-level require is a cycle.
        const gateRegistry = require('../../../consensus/gate_registry');
        return gateRegistry.activeAt(TOKEN_POLICY_INHERITANCE_KEY, resolved.network, resolved.coin, tip, null) === true;
    } catch(e){
        return false;
    }
}

module.exports = { TOKEN_POLICY_INHERITANCE_KEY, listAnyCoinItemsAtTip };
