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

function optionalTransactionSql(sql){
    if(!sql) return sql;
    let match = sql.match(/(?:INNER|LEFT)\s+JOIN transactions\s+t1 ON \(t1\.tx_index=(a\d+)\.tx_index\)/);
    if(!match) return sql;
    let actionAlias = match[1];
    return sql
        .replace(/INNER JOIN transactions(\s+)t1 ON \(t1\.tx_index=a\d+\.tx_index\)/g,
            'LEFT  JOIN transactions$1t1 ON (t1.tx_index=' + actionAlias + '.tx_index)')
        .replace(/(?:INNER|LEFT)\s+JOIN blocks(\s+)b1 ON \(b1\.block_index=t1\.block_index\)/g,
            'INNER JOIN blocks$1b1 ON (b1.block_index=' + actionAlias + '.block_index)');
}

module.exports = { optionalTransactionSql };
