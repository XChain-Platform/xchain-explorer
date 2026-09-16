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
 * XChain Explorer - Change Detector, mempool diff
 *
 * The per-poll diff of the decoder mempool snapshot that turns rows appearing
 * and disappearing into `mempool_action` and `mempool_removed` emits.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the method onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the method sat inline. The step
 * the long method was cut into is a plain module function rather than a second
 * prototype method, so the detector's method surface is the same set of names it
 * always had.
 *
 ********************************************************************/

'use strict';

class MempoolDiff {

    // Diff the decoder-DB mempool snapshot against the last poll. New rows emit
    // `mempool_action` (decoded: tx_hash/source/action/data/first_seen); rows that
    // left the mempool (confirmed or evicted; we can't tell which) emit
    // `mempool_removed` carrying {tx_hash, source, action, data} recovered from the
    // per-coin seenHashes Map. The Map stores the RAW action string rather than a
    // pre-computed party list because the subscriber set lives in ChannelManager,
    // which only the Broadcaster can reach: the removal path re-runs the shared
    // matcher against CURRENT subscribers, so a client that subscribed between the
    // action and the removal still gets the removal.
    // Rows are PRE-VALIDATION: a mempool action can still be rejected by the
    // indexer at confirmation, so consumers must treat these as provisional.
    async checkMempoolForCoin(coin) {
        if (typeof this.db.getDecoderMempoolRows !== 'function') return;
        const state = this.mempoolState[coin];
        if (!state) return;

        const WINDOW = 500;
        const rows = await this.db.getDecoderMempoolRows({ coin }, WINDOW);
        const { current, decodedNew, maxHash } = indexMempoolRows(this.db, state, rows);
        // The read is ORDER BY tx_hash LIMIT 500 (getDecoderMempoolRows). When the
        // window came back full the table may hold more rows than it covers, and
        // an already-seen hash sorting above the largest hash read was never
        // looked at: its absence proves nothing. Only a hash at or below that
        // bound is known gone. A short window covers the whole table.
        const covered = (rows.length >= WINDOW) ? maxHash : null;

        // First poll: seed without emitting (mirrors block/action init)
        if (!state.initialized) {
            state.seenHashes  = current;
            state.initialized = true;
            return;
        }

        for (const decoded of decodedNew)
            this.emit('mempool_action', coin, decoded);

        const next = current;
        for (const [hash, parties] of state.seenHashes) {
            if (current.has(hash)) continue;
            if (covered !== null && String(hash).toLowerCase() > covered) {
                // Out of the window's range: carry forward, unknown rather than gone.
                next.set(hash, parties);
                continue;
            }
            // Carry the tx's source, action name and raw action string on the
            // removal so the Broadcaster can fan the frame out to the same address
            // channels its mempool_action reached, and so a subscriber filtering by
            // `types` can be offered the removal of an action family it asked for.
            // The row itself is gone from the table by now, so this remembered
            // triple is the only surviving evidence of what the tx was and who it
            // involved.
            this.emit('mempool_removed', coin, {
                tx_hash: hash,
                source:  (parties && parties.source) || null,
                action:  (parties && parties.action) || null,
                data:    (parties && parties.data)   || null
            });
        }

        state.seenHashes = next;
    }
}

// One poll's window walked into the Map the next poll diffs against: every row
// keyed by tx_hash, the rows not seen before decoded (in window order) for the
// mempool_action emits, and the largest lowercased hash read, which bounds what a
// full window can prove gone. Nothing is emitted here; the caller decides whether
// this poll seeds or emits.
function indexMempoolRows(db, state, rows) {
    const current = new Map();
    const decodedNew = [];
    let maxHash = null;
    for (const row of rows) {
        if (!row || !row.tx_hash) continue;
        const key = String(row.tx_hash).toLowerCase();
        if (maxHash === null || key > maxHash) maxHash = key;
        const known = state.seenHashes.get(row.tx_hash);
        if (known !== undefined) {
            // Already announced on an earlier poll: carry its parties forward
            // untouched (a mempool row's action string is immutable, so there
            // is nothing to re-read and nothing to re-decode).
            current.set(row.tx_hash, known);
            continue;
        }
        const decoded = db.decodeMempoolRow(row);
        if (decoded) decodedNew.push(decoded);
        // Remember source + action name + the raw action string even for a row
        // that did not decode (garbage / rejected-ACTION sentinel): it emits no
        // mempool_action, but its disappearance still emits mempool_removed,
        // and the removal frame's shape must not depend on decodability.
        // `action` is the name decodeMempoolRow already normalized out of the
        // first segment (trimmed, uppercased, validated), so the removal names
        // the same family its mempool_action did, character for character. An
        // undecodable row keeps action null: it has no family to claim.
        current.set(row.tx_hash, {
            source: (decoded && decoded.source) || row.source || null,
            action: decoded ? decoded.action : null,
            data:   decoded ? decoded.data : null
        });
    }
    return { current, decodedNew, maxHash };
}

module.exports = MempoolDiff.prototype;
