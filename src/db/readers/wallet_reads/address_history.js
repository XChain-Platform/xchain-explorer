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
 * XChain Explorer - confirmed action history for a set of addresses
 *
 * The statements behind POST /{COIN}/api/history. Each one covers every
 * requested address at once, so a request costs three queries (four with a
 * since/until window) whether it names one address or twenty, and whether its
 * page holds one action or a hundred:
 *
 *   window   the block heights a since/until window resolves to (action_window.js)
 *   page     one merged newest-first page of action_indexes off mappings_actions
 *   rows     the per-address history feed's own columns for that page
 *   effects  the credits and debits that page moved for the requested addresses
 *
 * One part of src/db/readers/wallet_reads.js; `this` is the Database instance.
 *
 ********************************************************************/

'use strict';

const { resolveBlockWindow, actionWindowTerms, placeholders } = require('./action_window.js');
const { historyPageRowsQuery } = require('../action_detail_io/history_page.js');

// mappings_actions.type_id for an address mapping (1 is a ticker).
const ADDRESS_MAPPING = 2;

function addressPageSql(addressCount, extraTerms, limit){
    const where = ['ia.address IN (' + placeholders(addressCount) + ')', ...extraTerms];
    return `SELECT
                        m.action_index,
                        GROUP_CONCAT(ia.address) as addresses
                    FROM
                        index_addresses ia
                        INNER JOIN mappings_actions m ON (m.id=ia.id AND m.type_id=` + ADDRESS_MAPPING + `)
                    WHERE ` + where.join(' AND ') + `
                    GROUP BY m.action_index
                    ORDER BY m.action_index DESC
                    LIMIT ` + Number(limit);
}

// Credits as +1 and debits as -1, keyed back to the requested address spelling.
// A balance is credits minus debits (escrowed amounts are already debited), so
// these two tables are every movement of a spendable balance.
function addressEffectsSql(actionCount, addressCount){
    const actions = placeholders(actionCount);
    return `SELECT
                        x.action_index,
                        ia.address,
                        it.tick,
                        tk.decimals,
                        x.direction,
                        x.amount
                    FROM (
                        SELECT c1.action_index, c1.address_id, c1.tick_id, c1.amount, 1 as direction
                        FROM credits c1
                        WHERE c1.action_index IN (` + actions + `)
                        UNION ALL
                        SELECT d1.action_index, d1.address_id, d1.tick_id, d1.amount, -1 as direction
                        FROM debits d1
                        WHERE d1.action_index IN (` + actions + `)
                    ) x
                        INNER JOIN index_addresses ia ON (ia.id=x.address_id)
                        LEFT  JOIN index_tickers   it ON (it.id=x.tick_id)
                        LEFT  JOIN tokens          tk ON (tk.tick_id=x.tick_id)
                    WHERE ia.address IN (` + placeholders(addressCount) + `)
                    ORDER BY x.action_index DESC`;
}

class AddressHistoryReaders {
    /**
     * One page of the merged history of `addresses`, newest first: the
     * action_index and which requested addresses it is mapped to. `before` is the
     * exclusive keyset cursor; `since` and `until` are unix seconds, or null.
     */
    async getAddressHistoryPage(config, addresses, { limit, before, since, until }){
        const blocks = await resolveBlockWindow(this, config, since, until);
        if(blocks.empty) return [];
        const window = actionWindowTerms('m.action_index', blocks);
        const terms  = [...window.terms];
        const args   = [...addresses, ...window.args];
        if(before !== null && before !== undefined){
            terms.push('m.action_index < ?');
            args.push(before);
        }
        const rows = await this.doQuery(config, addressPageSql(addresses.length, terms, limit), args);
        return (rows || []).map((row) => ({
            action_index: Number(row.action_index),
            addresses:    [...new Set(String(row.addresses || '').split(',').filter(Boolean))]
        }));
    }

    // The per-address history feed's columns for a known page, newest first.
    async getAddressHistoryRows(config, actionIndexes){
        if(!actionIndexes.length) return [];
        const rows = await this.doQuery(config, historyPageRowsQuery({ order: 'DESC' }, actionIndexes.length), actionIndexes);
        return rows || [];
    }

    // Every credit and debit the page's actions wrote for the requested addresses.
    async getAddressHistoryEffects(config, actionIndexes, addresses){
        if(!actionIndexes.length || !addresses.length) return [];
        const args = [...actionIndexes, ...actionIndexes, ...addresses];
        const rows = await this.doQuery(config, addressEffectsSql(actionIndexes.length, addresses.length), args);
        return rows || [];
    }
}

module.exports = AddressHistoryReaders.prototype;
