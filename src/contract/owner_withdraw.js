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
 **********************************************************************/

/**
 * Whether a contract's deployer can still pull tokens out of its custody with
 * WITHDRAW (OWNER_WITHDRAW_OPT_IN), served as `owner_withdraw` on every
 * contract response so a wallet can stop offering a WITHDRAW consensus will
 * refuse and warn before a user funds a contract the deployer can drain.
 *
 * Presentation only: the indexer judges the action. This restates its rule
 * over the same stored bytes. Owner withdraw is ENABLED when the contract was
 * deployed before the activation instant for its network (DEPLOY block time
 * below it), or when its stored meta_json parses to a plain object whose
 * ownerWithdraw is the boolean true. Anything else is DISABLED.
 *
 * The answer is tri-state. null means the explorer cannot say (a network it
 * cannot resolve, or a row with no usable block time) and a consumer must
 * keep its default behaviour rather than read null as either answer. An
 * opted-in contract is enabled on every network, so its answer never needs
 * the network at all.
 */

'use strict';

const gateRegistry = require('../consensus/gate_registry.js');
const { env } = require('../config.js');
const { landingBlockTimes } = require('../federation/price_batches.js');

const OWNER_WITHDRAW_OPT_IN_KEY = 'owner_withdraw_opt_in.OWNER_WITHDRAW_OPT_IN';

/**
 * Whether stored meta_json opts the contract in. The same predicate as the
 * indexer's declaresOwnerWithdraw: only the boolean true opts in, and an absent
 * key, false, "true", 1, a null meta_json or bytes that do not parse to a plain
 * object all read as not opted in.
 *
 * @param   {?string} metaJson  the contract's stored meta_json
 * @returns {boolean}
 */
function declaresOwnerWithdraw(metaJson){
    if(typeof metaJson !== 'string')
        return false;
    let parsed;
    try { parsed = JSON.parse(metaJson); } catch(e) { return false; }
    if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    return Object.prototype.hasOwnProperty.call(parsed, 'ownerWithdraw') && parsed.ownerWithdraw === true;
}

/**
 * The activation instant for a network, or null for a network the rule has no
 * entry for. Regtest reads OWNER_WITHDRAW_OPT_IN_REGTEST_TIME with the indexer's
 * regtestTimeOverride grammar (parseInt, genesis on unset or unparseable), so an
 * explorer beside an indexer carrying the override answers the same instant.
 *
 * @param   {string} network  mainnet|testnet|regtest
 * @returns {?number}
 */
function activationTime(network){
    if(network === 'regtest')
        return parseInt(env.OWNER_WITHDRAW_OPT_IN_REGTEST_TIME) || 0;
    const table = gateRegistry.get(OWNER_WITHDRAW_OPT_IN_KEY);
    if(typeof network !== 'string' || !Object.prototype.hasOwnProperty.call(table, network))
        return null;
    const threshold = table[network];
    return (typeof threshold === 'number' && Number.isFinite(threshold)) ? threshold : null;
}

/**
 * The owner-withdraw answer for one contract.
 *
 * @param   {object}  args
 * @param   {?string} args.metaJson   the contract's stored meta_json
 * @param   {*}       args.blockTime  the DEPLOY block's block_time (number, string or BigInt)
 * @param   {?string} args.network    mainnet|testnet|regtest, or null when unresolved
 * @returns {?boolean} true enabled, false disabled, null unknown
 */
function ownerWithdrawState({ metaJson, blockTime, network }){
    if(declaresOwnerWithdraw(metaJson))
        return true;
    const threshold = activationTime(network);
    if(threshold === null)
        return null;
    const time = (blockTime === null || blockTime === undefined) ? NaN : parseInt(String(blockTime), 10);
    if(!Number.isFinite(time))
        return null;
    return time < threshold;
}

/**
 * Whether a row's answer depends on the DEPLOY block's protocol time rather than
 * its stored stamp. The indexer judges the gate on the median-time-past of the
 * deploy block on testnet, which never exceeds the raw stamp: so an opted-in
 * contract, or one stamped before the activation, is decided by the raw stamp
 * alone, and only an undeclared contract stamped at or after it can still read
 * as enabled once the median is applied.
 *
 * @param   {object}  row
 * @param   {?string} network
 * @returns {boolean}
 */
function needsProtocolTime(row, network){
    if(network !== 'testnet' || declaresOwnerWithdraw(row.meta_json))
        return false;
    const threshold = activationTime(network);
    const stamp  = (row.timestamp === null || row.timestamp === undefined) ? NaN : parseInt(String(row.timestamp), 10);
    const height = (row.block_index === null || row.block_index === undefined) ? NaN : Number(row.block_index);
    return threshold !== null && Number.isFinite(stamp) && stamp >= threshold &&
           Number.isSafeInteger(height) && height >= 0;
}

/**
 * Set `owner_withdraw` on a contract row that still carries its raw meta_json
 * and its DEPLOY block time as `timestamp` (the contract readers' alias for
 * b1.block_time). Must run before attachContractMeta, which drops meta_json.
 *
 * `times` is the map from DEPLOY height to protocol time that
 * attachOwnerWithdrawRows resolves. Given one, a row whose answer depends on
 * protocol time and whose height is absent from it is served as unknown (null),
 * never judged on the raw stamp. Without one the stored stamp is used as is.
 *
 * @param   {object}  row
 * @param   {?string} network
 * @param   {Map<number, number>} [times]
 * @returns {object}  the same row
 */
function attachOwnerWithdraw(row, network, times){
    if(!row || typeof row !== 'object') return row;
    let blockTime = row.timestamp;
    if(times instanceof Map && needsProtocolTime(row, network)){
        const height = Number(row.block_index);
        blockTime = times.has(height) ? times.get(height) : null;
    }
    row.owner_withdraw = ownerWithdrawState({
        metaJson:  row.meta_json,
        blockTime: blockTime,
        network:   network || null
    });
    return row;
}

/**
 * attachOwnerWithdraw over every row of a response, resolving the DEPLOY blocks'
 * protocol time for the rows that need it with one decoder read however many
 * rows there are. A failed or empty read leaves those rows unresolved, which
 * serves them as unknown.
 *
 * @param   {object}  db       the Database instance
 * @param   {object}  config   the request config carrying the route code
 * @param   {object|object[]} rows
 * @param   {?string} network
 * @returns {Promise<object|object[]>} the rows passed in
 */
async function attachOwnerWithdrawRows(db, config, rows, network){
    const list = Array.isArray(rows) ? rows : [rows];
    const needy = list.filter((row) => row && typeof row === 'object' && needsProtocolTime(row, network));
    let times = new Map();
    if(needy.length){
        try { times = await landingBlockTimes(db, config, network, needy); }
        catch(e){ times = new Map(); }
    }
    for(const row of list)
        attachOwnerWithdraw(row, network, times);
    return rows;
}

/**
 * The network a contract response is judged on: the route code's network, or
 * null when it names no configured coin or the configuration cannot be read,
 * which owner_withdraw serves as unknown rather than guessing mainnet. A module
 * function taking the Database, so the family adds no name to its prototype.
 *
 * @param   {object} db      the Database instance
 * @param   {object} config  the request config carrying the route code
 * @returns {Promise<?string>}
 */
async function resolveContractNetwork(db, config){
    try {
        const resolved = await db.resolveCoinNetwork(config);
        return resolved ? resolved.network : null;
    } catch(e){
        return null;
    }
}

module.exports = {
    OWNER_WITHDRAW_OPT_IN_KEY,
    declaresOwnerWithdraw,
    activationTime,
    ownerWithdrawState,
    attachOwnerWithdraw,
    attachOwnerWithdrawRows,
    resolveContractNetwork
};
