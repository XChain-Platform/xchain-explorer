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

const { isMissingTableError } = require('../../schema_probe.js');

function routeChain(config){
    let code = String((config && config.coin) || '').toUpperCase();
    let prefixed = code.match(/^[TR](BTC|LTC|DOGE)$/);
    return prefixed ? prefixed[1] : code;
}

function currentMemberCount(rootExpr){
    return `(SELECT COUNT(*)
                FROM list_items members
                WHERE members.action_index=COALESCE((
                    SELECT MAX(head.action_index)
                    FROM lists head
                        INNER JOIN index_statuses head_status ON (head_status.id=head.status_id)
                    WHERE head.list_action_index=${rootExpr}
                        AND head_status.status='valid'
                ), ${rootExpr}))`;
}

function homeRowsSql(){
    return `SELECT
                'home' AS kind,
                ? AS home_chain,
                share.list_action_index AS home_list_index,
                share.list_action_index AS local_list_index,
                root.type AS type,
                ${currentMemberCount('share.list_action_index')} AS member_count,
                share_block.block_index AS share_block,
                share.action_index AS share_action_index,
                NULL AS seq
            FROM lists share
                INNER JOIN actions share_action ON (share_action.action_index=share.action_index)
                INNER JOIN index_statuses share_status ON (share_status.id=share.status_id)
                INNER JOIN transactions share_tx ON (share_tx.tx_index=share_action.tx_index)
                INNER JOIN blocks share_block ON (share_block.block_index=share_tx.block_index)
                INNER JOIN lists root ON (root.action_index=share.list_action_index)
            WHERE share_action.action_format=2
                AND share_status.status='valid'
            ORDER BY share.action_index ASC`;
}

function mirrorRowsSql(){
    return `SELECT
                'mirror' AS kind,
                mirror.home_chain AS home_chain,
                mirror.home_list_index AS home_list_index,
                mirror.action_index AS local_list_index,
                root.type AS type,
                ${currentMemberCount('mirror.action_index')} AS member_count,
                mirror.block_index AS share_block,
                NULL AS share_action_index,
                (SELECT MAX(snapshot.seq)
                    FROM bridge_settlements settlement
                        INNER JOIN list_snapshots snapshot ON (snapshot.snapshot_id=settlement.transfer_id)
                    WHERE settlement.kind='list'
                        AND settlement.src_chain=mirror.home_chain
                        AND settlement.src_action_index=mirror.home_list_index) AS seq
            FROM list_share_mirrors mirror
                INNER JOIN lists root ON (root.action_index=mirror.action_index)
            ORDER BY mirror.home_chain ASC, mirror.home_list_index ASC`;
}

function numberOrNull(value){
    return (value === null || value === undefined) ? null : Number(value);
}

async function readListNames(reader, config, actionIndexes){
    let distinct = [...new Set(actionIndexes.map(Number).filter(Number.isFinite))];
    let names = {};
    for(let actionIndex of distinct) names[String(actionIndex)] = null;
    if(!distinct.length) return names;
    try {
        let rows = await reader.doQuery(config, `SELECT
                        m.list_action_index AS root,
                        m.action_index,
                        m.name
                    FROM list_metas m
                        INNER JOIN index_statuses s ON (s.id=m.status_id)
                    WHERE m.list_action_index IN (` + distinct.map(() => '?').join(',') + `)
                        AND s.status='valid'
                    ORDER BY m.action_index ASC`, distinct);
        for(let row of (rows || [])) names[String(Number(row.root))] = row.name;
    } catch(e){
        if(!isMissingTableError(e)) throw e;
    }
    return names;
}

function normalizeRow(row, owner, name){
    return {
        kind: row.kind,
        home_chain: row.home_chain,
        home_list_index: numberOrNull(row.home_list_index),
        local_list_index: numberOrNull(row.local_list_index),
        type: numberOrNull(row.type),
        name: name === undefined ? null : name,
        owner: owner === undefined ? null : owner,
        member_count: numberOrNull(row.member_count),
        share_block: numberOrNull(row.share_block),
        share_action_index: numberOrNull(row.share_action_index),
        seq: numberOrNull(row.seq)
    };
}

class SharedListReaders {
    async getSharedLists(config){
        let home = await this.doQuery(config, homeRowsSql(), [routeChain(config)]) || [];
        let mirrors = [];
        try {
            mirrors = await this.doQuery(config, mirrorRowsSql(), []) || [];
        } catch(e){
            if(!isMissingTableError(e)) throw e;
        }
        let roots = home.map(row => row.home_list_index);
        let owners = roots.length ? await this.getListOwnerAddresses(config, roots) : {};
        let localIndexes = home.map(row => row.home_list_index)
            .concat(mirrors.map(row => row.local_list_index));
        let names = await readListNames(this, config, localIndexes);
        let rows = home.map(row => normalizeRow(row, owners[String(Number(row.home_list_index))] || null,
            names[String(Number(row.home_list_index))]));
        rows.push(...mirrors.map(row => normalizeRow(row, null, names[String(Number(row.local_list_index))])));
        let sql = (config.data && config.data.sql) || {};
        let total = rows.length;
        let offset = Number(sql.apiOffset) || 0;
        let limit = Number(sql.limit) || total;
        return [rows.slice(offset, offset + limit), null, total];
    }
}

module.exports = SharedListReaders.prototype;
