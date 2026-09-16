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
 * XChain Explorer - federation read: getanchorconfirmations
 *
 * "What did THIS DOGE transaction anchor, and how deep is it?" A BTC indexer asks
 * before it mints an anchor or archive reward, and binds the returned publisher,
 * snapshot and sequence to the reward it is about to pay. Ported from the indexer
 * (src/actions/anchor/anchor_action_query/confirmations_query.js and the handler
 * in src/api/rpc/anchor.js) with the checks, the paging rules and the response
 * shape unchanged.
 *
 * BOUNDED AND PAGED. A page that silently omitted the matching anchor would read to
 * the caller as a complete non-matching set and forfeit a legitimate reward forever,
 * so one row past the cap is fetched as a probe and the answer says it was cut off
 * and where to resume.
 *
 ********************************************************************/

'use strict';

const { ANCHOR_ROW_LIMIT } = require('../db/federation_sql.js');
const { TXID_RE, normalizeVersion } = require('./anchor_action.js');
const { getLogger } = require('../observability');

const log = getLogger();

// Validate a request: one 64-hex txid plus an optional exclusive action_index cursor.
// The cursor is typed before it is numbered, because Number([]) is 0 and Number(true)
// is 1, and a cursor coerced to 0 would restart the walk forever.
function validateAnchorConfirmationsParams({ txid, after_action_index }) {
    // The key is a DOGE txid
    if (typeof txid !== 'string' || !TXID_RE.test(txid))
        return { ok: false, error: 'txid must be a 64-character hex string' };
    let after = null;
    if (after_action_index !== undefined && after_action_index !== null) {
        let n = (typeof after_action_index === 'number') ? after_action_index
              : (typeof after_action_index === 'string' && /^\d+$/.test(after_action_index)) ? Number(after_action_index)
              : NaN;
        // A supplied cursor must be a non-negative integer
        if (!Number.isInteger(n) || n < 0)
            return { ok: false, error: 'after_action_index must be a non-negative integer' };
        after = n;
    }
    return { ok: true, txid: txid.toLowerCase(), after };
}

// One anchor row as the response serves it. `latestNum` is passed in so the depth
// math cannot disagree with the caller's.
function mapConfirmationRow(row, latestNum) {
    let dogeBlock = Number(row.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    return {
        action_index:       (row.action_index != null) ? Number(row.action_index) : null,
        section_index:      (row.section_index != null) ? Number(row.section_index) : null,
        status:             row.status,
        version:            normalizeVersion(row.version),
        checkpoint_chain:   row.chain,
        checkpoint_network: row.network,
        block_index:        (row.block_index != null) ? Number(row.block_index) : null,
        checkpoint_seq:     (row.checkpoint_seq != null) ? Number(row.checkpoint_seq) : null,
        snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
        // The elected publisher the reward is attested to; null on unattested versions
        publisher:          row.publisher ? String(row.publisher).toLowerCase() : null,
        match_batch_seq:    (row.match_batch_seq != null) ? Number(row.match_batch_seq) : null,
        block_index_doge:   Number.isFinite(dogeBlock) ? dogeBlock : null,
        confirmations:      confirmations
    };
}

// Trim a truncated page so it never ends inside an action. A v0 bundle writes one row
// per section under one action_index, and an exclusive cursor landing inside it would
// drop the rest of that bundle from the walk. Returns the rows to keep.
function cutOnActionBoundary(all, kept) {
    let probeAction = all[ANCHOR_ROW_LIMIT].action_index;
    if (probeAction == null) return kept;
    let cut = kept.length;
    while (cut > 0 && String(kept[cut - 1].action_index) === String(probeAction)) cut--;
    // One action holding more rows than the cap cannot be cut cleanly; an empty page
    // would never advance the cursor, so keep the page and say so loudly.
    if (cut === 0) {
        log.error('FEDERATION_ANCHOR_PAGE_UNCUTTABLE', { action_index: String(probeAction), limit: ANCHOR_ROW_LIMIT });
        return kept;
    }
    return kept.slice(0, cut);
}

// Map a txid's rows and the tip into the response. `rows` is the cap plus the probe
// row; the probe never reaches the caller and its existence is reported as
// `truncated` with `next_after_action_index`. Invalid rows are reported, not filtered:
// "this txid exists and is invalid" and "not seen" must not collapse.
function buildAnchorConfirmationsResponse(chain, latest, rows) {
    let coin    = chain['COIN'];
    let network = chain['NETWORK'];
    let latestNum = Number(latest);
    let all       = Array.isArray(rows) ? rows : [];
    let truncated = all.length > ANCHOR_ROW_LIMIT;
    let kept      = truncated ? all.slice(0, ANCHOR_ROW_LIMIT) : all;
    if (truncated) kept = cutOnActionBoundary(all, kept);
    let lastKept  = kept.length > 0 ? kept[kept.length - 1] : null;
    let nextAfter = (truncated && lastKept && lastKept.action_index != null)
                  ? Number(lastKept.action_index) : null;
    let list = kept.map(row => mapConfirmationRow(row, latestNum));
    return { coin, network, exists: list.length > 0, latest_block_index: latest, anchors: list,
             truncated: truncated, next_after_action_index: nextAfter };
}

// The method body: validate, read the tip and one page of the txid's rows, map.
async function getanchorconfirmations({ db, dbConfig, chain }, {txid, after_action_index}) {
    let v = validateAnchorConfirmationsParams({ txid, after_action_index });
    if (!v.ok) return { error: v.error };
    try {
        let latest = await db.getMaxBlockIndex(dbConfig);
        let rows   = await db.getAnchorRowsByTxid(dbConfig, v.txid, v.after);
        return buildAnchorConfirmationsResponse(chain, latest, rows);
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getanchorconfirmations', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up anchor confirmations' };
    }
}

module.exports = { validateAnchorConfirmationsParams, buildAnchorConfirmationsResponse, getanchorconfirmations };
