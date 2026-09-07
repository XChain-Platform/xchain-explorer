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
 * XChain Explorer - hub-mirror endpoint resolution
 *
 * Single answer to "where does the self-synced mirror writer read the hub?",
 * shared by the startup invariant in db.js and the writer itself in
 * HubMirrorSyncManager.js so the two can never disagree about whether a
 * self_sync target is actually syncable.
 *
 * Two sources, in priority order:
 *
 *   1. database.checkpoint.hub_url, emitted by xchain-node's HubService in the
 *      SAME config block (and therefore under the same condition) as
 *      self_sync: true. This is the fix for the original defect - self_sync
 *      arrived over the hub's config push while HUB_API_URL was a container
 *      env var written at install time, so an explorer could be told to
 *      self-sync by one path while the other path never delivered a hub URL.
 *   2. The HUB_API_URL container env, kept for hand-written config.json
 *      deployments and for explorers installed before hub_url existed.
 *
 ********************************************************************/

// Resolve the hub REST base URL for one checkpoint target (a db.js
// checkpointDb entry, or any object carrying hubUrl). Returns '' when neither
// source names one; callers treat that as "this mirror has no writer".
function resolveHubUrl(target){
    let fromConfig = (target && target.hubUrl != null) ? String(target.hubUrl).trim() : '';
    if(fromConfig) return fromConfig;
    return String(process.env.HUB_API_URL || '').trim();
}

module.exports = { resolveHubUrl };
