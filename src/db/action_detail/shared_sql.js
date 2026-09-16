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
 * SQL statements for the shaping steps shared by more than one action-detail
 * handler (src/action-detail/shared.js): the de-blank baseline and the ledger effects.
 ********************************************************************/

'use strict';

// Read the baseline fields every action has, for the de-blank fallback.
const ACTION_BASELINE = `SELECT
                a2.action,
                a1.action_format,
                a1.action_index,
                a3.address as source,
                b1.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index
            FROM
                actions                       a1
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
            WHERE
                a1.action_index=?
            LIMIT 1`;

// Build the per-action read of one ledger-effect table (credits, debits or escrows).
function ledgerEffectsQuery(effect) {
    let a = effect.alias;
    return `SELECT
                    a1.address,
                    t1.tick,
                    ${a}.amount
                FROM
                    ${effect.table}
                    LEFT  JOIN index_tickers   t1 ON (t1.id=${a}.tick_id)
                    LEFT  JOIN index_addresses a1 ON (a1.id=${a}.address_id)
                WHERE
                    ${a}.action_index=?
                ORDER BY
                    t1.tick ASC,
                    CAST(${a}.amount as DECIMAL(64,18)) DESC,
                    a1.address ASC`;
}

// Build the page-wide read of one ledger-effect table over idxs. Same SELECT
// list and ORDER BY as ledgerEffectsQuery, with action_index added for grouping.
function ledgerEffectsBatchQuery(effect, idxs) {
    let a  = effect.alias;
    let ph = idxs.map(() => '?').join(',');
    return `SELECT
                    a1.address,
                    t1.tick,
                    ${a}.amount,
                    ${a}.action_index as _group_index
                FROM
                    ${effect.table}
                    LEFT  JOIN index_tickers   t1 ON (t1.id=${a}.tick_id)
                    LEFT  JOIN index_addresses a1 ON (a1.id=${a}.address_id)
                WHERE
                    ${a}.action_index IN (${ph})
                ORDER BY
                    ${a}.action_index ASC,
                    t1.tick ASC,
                    CAST(${a}.amount as DECIMAL(64,18)) DESC,
                    a1.address ASC`;
}

module.exports = {
    ACTION_BASELINE,
    ledgerEffectsQuery,
    ledgerEffectsBatchQuery
};
