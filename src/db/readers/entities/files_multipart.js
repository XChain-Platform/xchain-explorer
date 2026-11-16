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
 ********************************************************************/

'use strict';

class MultipartFileReaders {
    async getFilePartDetail(config, actionIndex) {
        const query = `SELECT fp.action_index, source.address AS source,
                              tx_hash.hash AS tx_hash, fp.block_index,
                              part_status.status AS status, fp.file_hash,
                              fp.part_index,
                              (SELECT MIN(fm.action_index)
                               FROM file_manifests fm
                               INNER JOIN index_statuses manifest_status
                                   ON (manifest_status.id=fm.status_id)
                               WHERE fm.source_id=fp.source_id
                                 AND fm.file_hash=fp.file_hash
                                 AND manifest_status.status='valid') AS manifest_action_index
                       FROM file_parts fp
                       INNER JOIN index_addresses source ON (source.id=fp.source_id)
                       INNER JOIN index_statuses part_status ON (part_status.id=fp.status_id)
                       INNER JOIN actions part_action ON (part_action.action_index=fp.action_index)
                       INNER JOIN transactions part_tx ON (part_tx.tx_index=part_action.tx_index)
                       INNER JOIN index_transactions tx_hash ON (tx_hash.id=part_tx.tx_hash_id)
                       WHERE fp.action_index=?
                       LIMIT 1`;
        const rows = await this.doQuery(config, query, [Number(actionIndex)]);
        return rows && rows.length ? rows[0] : null;
    }
}

module.exports = MultipartFileReaders.prototype;
