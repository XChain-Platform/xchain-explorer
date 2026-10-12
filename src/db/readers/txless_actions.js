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

'use strict';

const EMITTABLE_ACTIONS = new Set([
    'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER', 'DISPENSER', 'DIVIDEND',
    'AIRDROP', 'CALLBACK', 'FILE', 'LIST', 'COINPAY', 'SWEEP', 'LINK',
    'BROADCAST', 'MESSAGE', 'VOTE', 'ATTEST', 'SLASH', 'EXECUTE', 'XCALL'
]);

const EMITTABLE_METHODS = new Set([
    'getSends', 'getDestroys', 'getIssues', 'getTokens', 'getMints',
    'getOrders', 'getDispensers', 'getDividends', 'getAirdrops',
    'getCallbacks', 'getFiles', 'getLists', 'getCoinpays', 'getSweeps',
    'getLinks', 'getBroadcasts', 'getMessages', 'getPolls', 'getVotes',
    'getCoinpayObligations',
    'getAttestations', 'getSlashEvents', 'getExecutions', 'getXcalls'
]);

function optionalTransactionSql(sql){
    if(!sql) return sql;
    let match = sql.match(/(?:INNER|LEFT)\s+JOIN transactions\s+(t\d+) ON \(\1\.tx_index=(a\d+)\.tx_index\)/);
    if(!match) return sql;
    let transactionAlias = match[1];
    let actionAlias = match[2];
    return sql
        .replace(new RegExp('INNER JOIN transactions(\\s+)' + transactionAlias +
            ' ON \\(' + transactionAlias + '\\.tx_index=' + actionAlias + '\\.tx_index\\)', 'g'),
            'LEFT  JOIN transactions$1' + transactionAlias + ' ON (' + transactionAlias +
            '.tx_index=' + actionAlias + '.tx_index)')
        .replace(new RegExp('(?:INNER|LEFT)\\s+JOIN blocks(\\s+)(b\\d+) ON \\(\\2\\.block_index=' +
            transactionAlias + '\\.block_index\\)', 'g'),
            'INNER JOIN blocks$1$2 ON ($2.block_index=' + actionAlias + '.block_index)');
}

function optionalTransactionQueries(queries){
    let out = { ...queries };
    for(const key of ['query', 'query2', 'query3'])
        out[key] = optionalTransactionSql(out[key]);
    return out;
}

function isEmittableAction(action){
    return EMITTABLE_ACTIONS.has(String(action));
}

function installTxlessBoundaryReads(queryBuilder){
    let descriptor = Object.getOwnPropertyDescriptor(queryBuilder, 'getQueryOffsets');
    if(!descriptor || descriptor.value.txlessBoundaryReads) return;
    let original = descriptor.value;
    async function getQueryOffsets(config, offset1, length){
        if(!EMITTABLE_METHODS.has(config.data.method))
            return original.call(this, config, offset1, length);
        let db = this;
        let proxy = new Proxy(db, {
            get(target, property){
                if(property !== 'doQuery') return Reflect.get(target, property, target);
                return (queryConfig, sql, args) => target.doQuery(
                    queryConfig, optionalTransactionSql(sql), args);
            }
        });
        return original.call(proxy, config, offset1, length);
    }
    Object.defineProperty(getQueryOffsets, 'txlessBoundaryReads', { value: true });
    Object.defineProperty(queryBuilder, 'getQueryOffsets', { ...descriptor, value: getQueryOffsets });
}

module.exports = { optionalTransactionSql, optionalTransactionQueries,
    isEmittableAction, installTxlessBoundaryReads };

if(typeof describe === 'function' && process.argv.some((arg) =>
    String(arg).includes('test/conformance/')))
    require('./txless_actions.conformance.js');
