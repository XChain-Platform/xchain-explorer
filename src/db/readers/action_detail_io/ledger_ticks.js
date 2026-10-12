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
 * XChain Explorer - ledger ticks for the live feed
 *
 * Names the ticks each action of a getActionsSince batch moved, read from the
 * indexer's credit, debit and escrow rows, so the token channel can refresh the
 * ticks an action actually touched whatever the action's type.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// The ledger tables every balance movement writes, each keyed by action_index and
// tick_id. Compile-time literals interpolated as identifiers; every value is bound.
const LEDGER_TABLES = ['credits', 'debits', 'escrows'];

class ActionLedgerTickReaders {
    // action_index (as a decimal string) -> Set of the canonical ticks that action
    // credited, debited or escrowed. One UNION ALL round trip for the batch, an empty
    // input issues no query, and a failed read throws for the caller to degrade.
    async getActionLedgerTicks(config, indexes){
        let map = new Map();
        let list = (indexes || []).filter(index => !this.util.isNull(index));
        if(!list.length) return map;

        let holes = list.map(() => '?').join(',');
        let parts = [];
        let args  = [];
        for(let table of LEDGER_TABLES){
            parts.push(`SELECT
                            m.action_index as action_index,
                            t1.tick as tick
                        FROM
                            ${table} m
                            INNER JOIN index_tickers t1 ON (t1.id=m.tick_id)
                        WHERE
                            m.action_index IN (${holes})`);
            // Bound as the driver gave them (BigInt above 2^53), never re-stringified.
            args.push(...list);
        }
        let rows = await this.doQuery(config, parts.join(' UNION ALL '), args);
        for(let row of (rows || [])){
            if(!row || this.util.isNull(row.action_index) || this.util.isNull(row.tick)) continue;
            let key  = String(row.action_index);
            let ticks = map.get(key);
            if(!ticks){
                ticks = new Set();
                map.set(key, ticks);
            }
            ticks.add(String(row.tick));
        }
        return map;
    }
}

module.exports = ActionLedgerTickReaders.prototype;
