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

async function resolveFilePartDetail(actionIndex, { readPart, buildPart }) {
    const row = await readPart(actionIndex);
    return row === null ? null : buildPart(row);
}

function needsManifestSummary(detail) {
    if(detail === null || detail === undefined) return false;
    return detail.action_format === 1 || detail.action_format === '1';
}

async function attachMultipartSummary(detail, { readManifest, buildSummary }) {
    if(!needsManifestSummary(detail)) return detail;

    const record  = await readManifest();
    const summary = buildSummary(record);
    if(summary === null || summary === undefined) return detail;

    return { ...detail, multipart: summary };
}

module.exports = {
    resolveFilePartDetail,
    needsManifestSummary,
    attachMultipartSummary
};
