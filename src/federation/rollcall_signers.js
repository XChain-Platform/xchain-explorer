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
 * XChain Explorer - federation read: getrollcallsigners
 *
 * "Which of THESE keys have a presence signature on chain for THIS epoch, inside
 * THIS window?", answered DOGE side for a BTC indexer's roll-call epoch close.
 * Ported from the indexer (src/api/rollcall_signers.js and the handler in
 * src/api/rpc/rollcall.js) with the request checks, the refusal strings, the key
 * ceiling and the response shape unchanged.
 *
 * Bounded by the caller's key lists, never by enumeration: the close asks for
 * exactly the keys it needs, so no attacker-inflated action set can truncate the
 * answer into a false absence. Everything returned is structure; the BTC side
 * re-verifies each signature against its own ledger hash.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { getLogger } = require('../observability');

const log = getLogger();

// Upper bound on the key lists this read answers over. The close asks for the
// responsible set plus one, so this is a ceiling on a malformed or hostile caller,
// not a paging limit.
const ROLLCALL_READ_MAX_KEYS = 2048;

// The explorer's vendored action manifest, byte-identical to canonical (a
// conformance suite pins it). The Docker image ships it at this same path.
const MANIFEST_PATH = path.join(__dirname, '..', '..', 'test', 'fixtures', 'action-manifest.json');

// Memo for the manifest hash; undefined until the first read.
let manifestHashMemo;

// sha256 of the vendored action manifest, the software-version signal the BTC
// close compares against its own copy and defers on when they differ. An
// unreadable file answers null, which can never match, so the close defers
// rather than trusting an answer nobody can version.
//
// This is the EXPLORER's manifest, not the one the replicated rows were decoded
// under: a replica cannot see its source's decoder build. That is accepted
// because the only source of these replicas is the platform's own DOGE indexer,
// upgraded in the same release train as the explorer, so the stale third-party
// decoder this signal exists to catch is never behind this endpoint. A validator
// on an older manifest still defers here until it upgrades. If a replica ever
// comes from a source outside that train, the source's hash has to travel with
// its rows instead.
function rollcallManifestHash() {
    if (manifestHashMemo !== undefined) return manifestHashMemo;
    try {
        manifestHashMemo = crypto.createHash('sha256').update(fs.readFileSync(MANIFEST_PATH)).digest('hex');
    } catch (e) {
        log.error('FEDERATION_MANIFEST_UNREADABLE', { path: MANIFEST_PATH, err: e.message });
        manifestHashMemo = null;
    }
    return manifestHashMemo;
}

// The caller's request checked in the indexer's order: DOGE only, this network,
// numeric epoch and window, bounded hex key lists. `chain` is { COIN, NETWORK } for
// the coin the request was routed to. Returns { error } on the first refusal.
function rollcallSignersRequest(chain, {network, epoch_height, max_block_time, pubkeys, publishers}) {
    // The presence table only exists on the DOGE side
    if (String(chain['COIN']) !== 'DOGE')
        return { error: 'getrollcallsigners is DOGE-only' };
    // A caller asking about another network is asking the wrong replica
    if (network !== undefined && String(network) !== String(chain['NETWORK']))
        return { error: 'network mismatch' };

    let epoch = parseInt(epoch_height);
    let maxT  = parseInt(max_block_time);
    // The epoch must be a non-negative height and the window end a number
    if (!Number.isFinite(epoch) || epoch < 0) return { error: 'invalid epoch_height' };
    if (!Number.isFinite(maxT))               return { error: 'invalid max_block_time' };

    let keys = Array.isArray(pubkeys)    ? pubkeys    : [];
    let pubs = Array.isArray(publishers) ? publishers : [];
    // Keep only 64-hex keys: a caller asking about a key it cannot name is enumerating
    const HEX64 = /^[0-9a-fA-F]{64}$/;
    keys = keys.filter((k) => HEX64.test(String(k))).map((k) => String(k).toLowerCase());
    pubs = pubs.filter((k) => HEX64.test(String(k))).map((k) => String(k).toLowerCase());
    // Refuse a key list past the ceiling rather than answer part of it
    if (keys.length > ROLLCALL_READ_MAX_KEYS || pubs.length > ROLLCALL_READ_MAX_KEYS)
        return { error: 'too many keys requested' };
    return { epoch, maxT, keys, pubs };
}

// Every asked-about key's presence signature and every asked-about publisher's roll
// call at or below the window cut, keyed lowercase. A key with no row, and every key
// while there is no cut yet, stays null so the caller cannot read "none" into it.
async function rollcallPresence(db, dbConfig, epoch, keys, pubs, hcut) {
    let signers = {};
    for (let k of keys) signers[k] = null;
    let publishersOut = {};
    for (let k of pubs) publishersOut[k] = null;

    if (hcut !== null) {
        for (let r of await db.getRollcallSignersForKeys(dbConfig, epoch, keys, hcut)) {
            signers[String(r.pubkey).toLowerCase()] = {
                sig:          String(r.sig).toLowerCase(),
                ledger_hash:  String(r.ledger_hash).toLowerCase(),
                publisher:    String(r.publisher).toLowerCase(),
                action_index: Number(r.action_index),
                block_index:  Number(r.block_index),
                // ROLLCALL v1 GATES as carried, null on a v0 row
                gates:        (r.gates === undefined || r.gates === null) ? null : String(r.gates)
            };
        }
        for (let r of await db.getRollcallPublishers(dbConfig, epoch, pubs, hcut)) {
            publishersOut[String(r.publisher).toLowerCase()] = {
                action_index: Number(r.action_index),
                block_index:  Number(r.block_index)
            };
        }
    }
    return { signers, publishersOut };
}

// The method body. `hcut` null, or a tip that has not buried the cut, is the
// caller's cue to defer; this read reports both and decides neither.
async function getrollcallsigners({ db, dbConfig, chain }, {network, epoch_height, max_block_time, pubkeys, publishers}) {
    let req = rollcallSignersRequest(chain, { network, epoch_height, max_block_time, pubkeys, publishers });
    if (req.error) return req;
    let { epoch, maxT, keys, pubs } = req;
    try {
        let tipIndex = await db.getMaxBlockIndex(dbConfig);
        let tipTime  = await db.getBlockTimeAtHeightOrNull(dbConfig, tipIndex);
        let hcut     = await db.getRollcallWindowCut(dbConfig, maxT);
        let { signers, publishersOut } = await rollcallPresence(db, dbConfig, epoch, keys, pubs, hcut);
        return {
            hcut,
            tip_block_index: (tipIndex === null || tipIndex === undefined) ? null : Number(tipIndex),
            tip_block_time:  Number.isFinite(tipTime) ? tipTime : null,
            manifest_hash:   rollcallManifestHash(),
            signers,
            publishers: publishersOut
        };
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getrollcallsigners', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up rollcall signers' };
    }
}

module.exports = {
    ROLLCALL_READ_MAX_KEYS, MANIFEST_PATH,
    rollcallManifestHash, rollcallSignersRequest, rollcallPresence, getrollcallsigners
};
