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
 * Stored block protocol-time reads.
 ********************************************************************/

'use strict';

const protocolTime = require('../../../consensus/protocol_time.js');

class HealthProtocolTimeReaders {
    async getProtocolTimesForBlocks(config, blockIndexes, network) {
        let keys = [...new Set((blockIndexes || []).map(Number)
            .filter((key) => Number.isSafeInteger(key) && key >= 0))];
        if(keys.length === 0) return new Map();
        let span = protocolTime.isProtocolTimeMtpActive(network)
            ? protocolTime.MEDIAN_TIME_SPAN : 0;
        let requested = keys.map(() => 'SELECT ? AS block_index').join(' UNION ALL ');
        let query = `SELECT requested.block_index AS requested_block_index,
                            b.block_index, b.block_time
                     FROM (${requested}) requested
                     INNER JOIN blocks b ON
                         b.block_index BETWEEN GREATEST(0, requested.block_index - ?)
                                           AND requested.block_index
                     ORDER BY requested.block_index ASC, b.block_index DESC`;
        let rows = await this.doQuery(config, query, [...keys, span]);
        let windows = new Map(keys.map((key) => [key, []]));
        for(let row of (rows || [])){
            let key = Number(row.requested_block_index);
            if(windows.has(key)) windows.get(key).push(row);
        }
        let result = new Map();
        for(let key of keys){
            let window = windows.get(key);
            let current = window.find((row) => Number(row.block_index) === key);
            if(!current) continue;
            let previous = window.filter((row) => Number(row.block_index) < key)
                .slice(0, span).map((row) => row.block_time);
            let resolved = protocolTime.protocolTime(network, current.block_time, previous);
            if(resolved !== false && resolved !== null && resolved !== undefined)
                result.set(key, Number(resolved));
        }
        return result;
    }
}

module.exports = HealthProtocolTimeReaders.prototype;
