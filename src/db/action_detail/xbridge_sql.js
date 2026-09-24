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
 * SQL text for the XBRIDGE action-detail handler in src/action-detail/tokens.js.
 * Both tables exist only on a replica that has taken the indexer's bridge-tables
 * migration, so each is named as data and the handler probes the connected
 * schema for it (src/db/schema_probe.js) before naming it in a statement.
 ********************************************************************/

'use strict';

// The settle table the XBRIDGE pass writes, keyed by the injected leg's own index.
const BRIDGE_SETTLEMENTS_TABLE = 'bridge_settlements';

const XBRIDGE_SETTLEMENT = `SELECT transfer_id, kind, block_index, src_chain, src_action_index, dest_chain, dest_address, tick
             FROM bridge_settlements WHERE action_index=? LIMIT 1`;

// The user leg's own action record, written by the indexer at parse time on the chain
// the lock or burn was broadcast from.
const XBRIDGES_TABLE = 'xbridges';

const XBRIDGE_RECORD = `SELECT
                    x1.dest_chain,
                    a1.address as dest_address,
                    t1.tick,
                    x1.decimals,
                    x1.min_depth,
                    m1.memo,
                    s1.status
                FROM
                    xbridges x1
                    LEFT  JOIN index_addresses    a1 ON (a1.id=x1.dest_address_id)
                    LEFT  JOIN index_tickers      t1 ON (t1.id=x1.tick_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=x1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=x1.status_id)
                WHERE
                    x1.action_index=?
                LIMIT 1`;

module.exports = {
    BRIDGE_SETTLEMENTS_TABLE,
    XBRIDGE_SETTLEMENT,
    XBRIDGES_TABLE,
    XBRIDGE_RECORD
};
