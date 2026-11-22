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
 * Build compact ATTEST list summaries.
 */

function actionDetailAttestListSummary(data, batchLabel){
    let version = Number(data[4]);
    let batch = [5, 6].includes(version);
    let type = version === 5
        ? '<span class="badge text-bg-info text-dark">Batch head</span>'
        : version === 6
            ? '<span class="badge text-bg-info text-dark">Batch continuation</span>'
            : version === 0
                ? '<span class="badge text-bg-secondary">Request</span>'
                : '<span class="badge text-bg-primary">Response</span>';
    let label = batchLabel({
        version: version,
        batch_window_start: data[15], batch_window_end: data[16], batch_row_count: data[17],
        batch_chunk_index: data[19], batch_total_chunks: data[20]
    });
    return { batch: batch, key: data[14], label: label, type: type };
}

if(typeof module !== 'undefined' && module.exports)
    module.exports = { actionDetailAttestListSummary: actionDetailAttestListSummary };
