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
 * XChain Explorer - action destinations for the live feed
 *
 * Attaches the recipients of each action to a getActionsSince batch, from
 * the destination-bearing families listed below.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

// The action families that carry a real RECIPIENT, and the column on each that
// points back at the action (decision I-46, measured against xchain-indexer/src/sql).
// Backs getActionsSince's `destinations` (spec wallet-unconfirmed-and-sounds M1.4).
//
// Two things here are load-bearing and easy to get wrong:
//
//   - `contracts` is DELIBERATELY ABSENT. It carries `slash_destination_id`, not
//     `destination_id`, and that column is DEPLOY-time slash ROUTING CONFIG, not a
//     recipient of anything. Including it would fan "you received something" out to
//     every address a contract merely names in its deploy, which is the opposite of
//     what the wallet's incoming-receipt notification means. It is also the only
//     destination-ish column not named `destination_id`, which is how a naive grep
//     sweeps it back in; do not add it.
//   - Three of the join keys are NOT `action_index`. `slash_events` keys on
//     `execution_index` (FK to contract_executions.action_index) and
//     `capability_slash_events` on `slash_action_index` (FK to actions.action_index).
//     Joining either on `action_index` silently matches nothing, since neither table
//     has that column at all.
//
// `sends.action_index` is a NON-unique index on purpose: a multi-output SEND is
// several rows sharing one action_index, and every one of their destinations must
// reach the wire. That is why the lookup below collects a LIST per action rather
// than a single value.
//
// These table/column names are compile-time literals interpolated as SQL
// IDENTIFIERS (a placeholder cannot bind an identifier). No caller can reach them:
// nothing outside this constant is ever spliced into the query, and every VALUE is
// still bound with `?`.
const ACTION_DESTINATION_FAMILIES = [
    { table: 'sends',                   key: 'action_index'       },
    { table: 'sweeps',                  key: 'action_index'       },
    { table: 'dispenses',               key: 'action_index'       },
    { table: 'mints',                   key: 'action_index'       },
    { table: 'messages',                key: 'action_index'       },
    { table: 'fees',                    key: 'action_index'       },
    { table: 'slash_events',            key: 'execution_index'    },
    { table: 'capability_slash_events', key: 'slash_action_index' }
];

class ActionDestinationReaders {
    // Fill `destinations: string[]` on every row of a getActionsSince batch, in
    // place. Backs NEW_ACTION's additive destinations field (spec M1.4): the feed
    // has never selected a destination column, so the Broadcaster's destination
    // routing branch has been permanently inert and the wallet's incoming-receipt
    // notification has never fired for anyone.
    //
    // SHAPE: ONE round trip for the whole batch, a UNION ALL over the eight
    // destination-bearing families (ACTION_DESTINATION_FAMILIES) filtered by the
    // action_index values ACTUALLY FETCHED. This feed drives the 5s ChangeDetector
    // poll, so a per-row lookup would cost up to `limit` (100) round trips every
    // five seconds per coin; a per-family lookup would cost eight. The IN list is
    // built from the fetched rows rather than from the cursor range, so a catch-up
    // burst binds exactly as many parameters as it has actions (<= limit * 8), and
    // an EMPTY batch issues no query at all.
    //
    // FAILURE MODE, deliberately soft: a failed lookup degrades every row to
    // `destinations: []` and the actions still ship. There is scar tissue here. A
    // prior `s1.id=a1.status_id` join against a column that does not exist threw
    // ER_BAD_FIELD_ERROR and SILENTLY killed the entire WebSocket action feed,
    // because getActionsSince returned [] every poll while the detector's cursor
    // kept advancing past the actions nobody ever saw (see the note on the query
    // above). An enrichment must never be able to do that again: destinations are a
    // nice-to-have on a frame whose delivery is not.
    //
    // Every row is given the key unconditionally and up front, so a subscriber
    // never has to tell "no destinations" from "the lookup failed" from "the field
    // is missing": all three are `[]`.
    async attachActionDestinations(config, rows){
        let indexes = [];
        for(let row of rows){
            row.destinations = [];
            if(!this.util.isNull(row.action_index)) indexes.push(row.action_index);
        }
        if(!indexes.length) return rows;

        let map = await this.getActionDestinationMap(config, indexes);
        for(let row of rows){
            let list = map.get(String(row.action_index));
            if(list) row.destinations = list;
        }
        return rows;
    }

    // action_index (as a decimal string) -> ordered, DEDUPED list of destination
    // addresses, for the given batch of action indexes. Returns an EMPTY map, never
    // throws: every caller treats "no destinations" and "lookup broke" identically.
    async getActionDestinationMap(config, indexes){
        // Lazily initialized (not in the constructor) because the unit harness
        // builds a Database with Object.create(Database.prototype) and never runs it.
        if(!this._actionDestinationSkip) this._actionDestinationSkip = new Map();
        let skip     = this._actionDestinationSkip.get(config.coin) || new Set();
        let families = ACTION_DESTINATION_FAMILIES.filter(f => !skip.has(f.table));
        let map      = new Map();
        if(!families.length) return map;

        try {
            let [query, args] = this.actionDestinationSql(families, indexes);
            this.collectActionDestinations(map, await this.doQuery(config, query, args));
            return map;
        } catch(e){
            // The union is all-or-nothing: one absent table (an older deployment
            // without capability_slash_events, say) loses the destinations of all
            // eight families. Retry family by family so the rest still resolve, and
            // QUARANTINE only the ones that fail for a schema reason, so the steady
            // state on such a deployment is back to one query per poll rather than
            // nine. A transient failure (connection lost) is deliberately NOT
            // quarantined: it would silence destinations permanently for a fault
            // that clears on its own.
            map.clear();
            for(let family of families){
                try {
                    let [q, a] = this.actionDestinationSql([family], indexes);
                    this.collectActionDestinations(map, await this.doQuery(config, q, a));
                } catch(err){
                    if(this.isSchemaShapeError(err)){
                        skip.add(family.table);
                        this._actionDestinationSkip.set(config.coin, skip);
                        log.error('ACTION_DESTINATIONS_FAMILY_DISABLED', { table: family.table,
                            coin: config.coin, err: err && err.message });
                    }
                }
            }
            return map;
        }
    }

    // Build the UNION ALL (or the single-family retry). INNER JOIN on
    // index_addresses is what drops a NULL destination_id and an id that resolves to
    // nothing, so the result set holds only real, literal addresses.
    actionDestinationSql(families, indexes){
        let holes = indexes.map(() => '?').join(',');
        let parts = [];
        let args  = [];
        for(let family of families){
            parts.push(`SELECT
                            m.${family.key} as action_index,
                            a1.address as destination
                        FROM
                            ${family.table} m
                            INNER JOIN index_addresses a1 ON (a1.id=m.destination_id)
                        WHERE
                            m.${family.key} IN (${holes})`);
            // Bound as VALUES, and passed through as the driver gave them to us
            // (BIGINT reads back as a BigInt on this pool): re-stringifying them
            // would make MariaDB compare a quoted literal against a BIGINT column as
            // a DOUBLE, the same >2^53 collapse the cursor comment above warns about.
            args.push(...indexes);
        }
        return [parts.join(' UNION ALL '), args];
    }

    // Fold one result set into the map. Deduped per action because the same address
    // can legitimately appear twice (a multi-output SEND paying one address twice,
    // or a fee and a send landing on the same treasury): a subscriber must not be
    // told about it twice, and the Broadcaster must not broadcast to that channel
    // twice. Insertion order is kept so the wire order is stable across polls.
    collectActionDestinations(map, rows){
        if(!rows || !rows.length) return map;
        for(let row of rows){
            if(!row || this.util.isNull(row.action_index) || this.util.isNull(row.destination)) continue;
            let key  = String(row.action_index);
            let list = map.get(key);
            if(!list){
                list = [];
                map.set(key, list);
            }
            if(!list.includes(row.destination)) list.push(row.destination);
        }
        return map;
    }

    // "That table or column does not exist here", seen through doQuery's wrapper.
    // doQuery rethrows as DbQueryError with its OWN code ('DB_ERROR') and the
    // driver's SqlError on .cause, so testing the top-level error alone never
    // matches a real one; walk the (short, bounded) cause chain. Mirrors
    // ChangeDetector.isMissingTableError, widened to the bad-column case because
    // that is the exact error class that killed this feed once already.
    isSchemaShapeError(err){
        for(let e = err, depth = 0; e && depth < 5; e = e.cause, depth++){
            if(e.code === 'ER_NO_SUCH_TABLE'   || Number(e.errno) === 1146) return true;
            if(e.code === 'ER_BAD_FIELD_ERROR' || Number(e.errno) === 1054) return true;
        }
        return false;
    }
}

module.exports = ActionDestinationReaders.prototype;
