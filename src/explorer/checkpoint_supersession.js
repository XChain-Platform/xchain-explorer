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
 * Pure response fields for append-only checkpoint supersession rows.
 *
 ********************************************************************/

'use strict';

function supersededBySeq(row, rows){
    const rowSeq = Number(row.checkpoint_seq);
    const blockIndex = Number(row.block_index);
    let lowest = null;

    for(const candidate of rows){
        const candidateSeq = Number(candidate.checkpoint_seq);
        if(candidate.chain !== row.chain || candidate.network !== row.network ||
            candidate.supersedes_from === null || candidate.supersedes_from === undefined ||
            candidateSeq <= rowSeq || Number(candidate.supersedes_from) > blockIndex)
            continue;
        if(lowest === null || candidateSeq < lowest) lowest = candidateSeq;
    }

    return lowest;
}

function supersessionBody(row, rows){
    return {
        superseded_by_seq: supersededBySeq(row, rows),
        supersedes_from: row.supersedes_from === null || row.supersedes_from === undefined
            ? null
            : Number(row.supersedes_from)
    };
}

module.exports = { supersededBySeq, supersessionBody };
