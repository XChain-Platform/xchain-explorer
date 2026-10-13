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
 * XChain Explorer - bridge token-panel readers
 *
 * Reads the hub-mirrored transfer and policy rows through the routed
 * coin's co-located checkpoint schema. Applied policy is additionally
 * proven by the local bridge_settlements record and joined to the local
 * token row whose list pointers the snapshot materialized.
 *
 ********************************************************************/

'use strict';

const MAX_BRIDGE_TRANSFERS = 100;

function mirrorTable(schema, table){
    if(!/^[A-Za-z0-9_$]+$/.test(String(schema || '')))
        throw new Error('Invalid bridge mirror schema');
    return '`' + schema + '`.' + table;
}

class BridgePanelReaders {
    // Return the newest transfer rows involving this routed chain. Tick is indexed
    // in the mirror and the caller-supplied limit is clamped to the public cap.
    async getBridgeTransfers(config){
        const table = mirrorTable(config.schema, 'bridge_transfers');
        const requested = Number(config.limit);
        const limit = Number.isInteger(requested)
            ? Math.max(1, Math.min(MAX_BRIDGE_TRANSFERS, requested)) : MAX_BRIDGE_TRANSFERS;
        const query = `SELECT
                           b.transfer_id,
                           CAST(b.snapshot_block AS CHAR) AS snapshot_block,
                           b.src_chain,
                           CAST(b.src_action_index AS CHAR) AS src_action_index,
                           b.src_address, b.dest_chain, b.dest_address, b.tick,
                           b.decimals, b.amount,
                           CAST(b.effective_time AS CHAR) AS effective_time,
                           b.status
                       FROM ${table} b
                       WHERE b.tick IN (?, ?) AND b.network = ?
                         AND (b.src_chain = ? OR b.dest_chain = ?)
                       ORDER BY b.id DESC
                       LIMIT ?`;
        return await this.doQuery(config, query,
            [config.tick, config.copyTick, config.network, config.chain, config.chain, limit]);
    }

    // Read the highest signed snapshot that this chain has actually applied.
    // The composite policy key supplies the descending sequence walk, while the
    // settlement EXISTS probe uses bridge_settlements' unique transfer/kind key.
    async getAppliedPolicy(config){
        const table = mirrorTable(config.schema, 'policy_snapshots');
        const query = `SELECT
                           CAST(p.policy_seq AS CHAR) AS policy_seq,
                           CAST(p.origin_block AS CHAR) AS origin_block,
                           p.policy_hash,
                           CAST(t.allow_list AS CHAR) AS allow_list_action_index,
                           CAST(t.block_list AS CHAR) AS block_list_action_index,
                           p.sleeping
                       FROM ${table} p
                       INNER JOIN index_tickers i ON i.tick = ?
                       INNER JOIN tokens t ON t.tick_id = i.id
                       WHERE p.network = ? AND p.origin_chain = ? AND p.tick = ?
                         AND p.status = ?
                         AND EXISTS (
                             SELECT 1
                             FROM bridge_settlements s
                             WHERE s.transfer_id = p.snapshot_id AND s.kind = ?
                         )
                       ORDER BY p.policy_seq DESC
                       LIMIT 1`;
        const rows = await this.doQuery(config, query, [
            config.copyTick, config.network, config.origin, config.tick, 'finalized', 'policy'
        ]);
        return rows && rows.length ? rows[0] : null;
    }
}

module.exports = BridgePanelReaders.prototype;
