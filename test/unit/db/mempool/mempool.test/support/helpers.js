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
 * Unit tests for the decoder-DB mempool surface: db.getDecoderMempoolRows /
 * db.decodeMempoolRow / db.getMempool, the ChangeDetector mempool diffing,
 * and Broadcaster MEMPOOL_ACTION / MEMPOOL_REMOVED routing. The decoder DB
 * is stubbed throughout; no real database.
 *
 * Encoding contract: mempool_transactions.data holds the canonical
 * UTF-8 ACTION string, byte-identical to what the decoder's confirmed-block
 * path writes to transactions.data. It is not hex. The fixtures below are
 * therefore plain text, and the drift guard at the bottom of this file pins the
 * explorer's read against the decoder's actual write so neither side can move
 * alone.
 */

'use strict';

const fs             = require('fs');
const path           = require('path');
const sinon          = require('sinon');
const { expect }     = require('chai');
const Database       = require('../../../../../../src/db/index.js');
const ChangeDetector = require('../../../../../../src/ws/change_detector.js');
const Broadcaster    = require('../../../../../../src/ws/broadcaster.js');
const { envView }    = require('../../../../../fixtures/mock-config.js');

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

// A db instance with the decoder name map + stubbed query layer.
function mkDb(rows) {
    const db = Object.create(Database.prototype);
    const Utility = require('../../../../../../src/lib/utility.js');
    db.util = new Utility();
    // The db/ readers read every environment variable through config.js's
    // env object, so a hand-built Database needs the same key the real
    // configInfo carries; the fixture's view is live over process.env.
    db.configInfo = { env: envView };
    db.decoderDb = { RBTC: 'XChain_BTC_Decoder' };
    db.doQuery = sinon.stub().resolves(rows);
    // getMempool TYPE=address forward-resolves the queried address to its index
    // id (byte-exactly, to match compacted `^<id>` destinations). Stub it here so
    // the shared doQuery stub is not asked to answer two different queries; the
    // compacted path has its own tests in db.mempool-address-refs.test.js.
    db.getExactAddressId = sinon.stub().resolves(null);
    return db;
}

const SEND_ROW  = { tx_hash: 'aa11', source: 'srcAddr1', data: 'SEND|0|TOK|5|destAddr1|nonce123' };
const MINT_ROW  = { tx_hash: 'bb22', source: 'srcAddr2', data: 'MINT|0|OTHER|9' };
const TRASH_ROW = { tx_hash: 'cc33', source: 'srcAddr3', data: 'zz-not-an-action-!!' };
// A row written by an older decoder that still hex-encoded the payload.
// It must NOT decode: the mempool feed drops it rather than showing mojibake.
const LEGACY_HEX_ROW = { tx_hash: 'dd44', source: 'srcAddr4', data: hex('SEND|0|TOK|5|destAddr1|nonce123') };

const unitDir = path.resolve(__dirname, '..', '..', '../..');

function getDecoderPaths() {
    const decoderRoot = process.env.XCHAIN_DECODER_ROOT ||
        path.resolve(unitDir, '../../../xchain-decoder');
    const decoderSrc = path.join(decoderRoot, 'src', 'XChainDecoder.js');
    return { decoderSrc, hasDecoder: fs.existsSync(decoderSrc) };
}

function loadCanonicalizer(decoderSrc) {
    try {
        return { canonicalizeActionPayload: require(decoderSrc).canonicalizeActionPayload, decoderLoadFailed: false };
    } catch (e) {
        return { canonicalizeActionPayload: null, decoderLoadFailed: true };          // sibling checkout without installed deps
    }
}

function makeEncodingFixture() {
    return {
        strict: new TextDecoder('utf-8', { fatal: true }),
        db: mkDb([]),
        SAMPLES: [
            'SEND|0|TOK|5|destAddr1|nonce123',
            'ATTEST|0|hello world',
        ]
    };
}

// Reads the first file (in order) that contains `needle`, so a reader survives
// the decoder moving text out of the entry into a part file beside it: the part
// is checked first because a split lands the callable text there, then the
// entry for a checkout still at the pre-split layout. Neither holding the text
// is a loud failure naming both paths, never a silent empty match.
function locateText(paths, needle) {
    for (const candidate of paths) {
        if (!fs.existsSync(candidate)) continue;
        const src = fs.readFileSync(candidate, 'utf8');
        const at = src.indexOf(needle);
        if (at !== -1) return { path: candidate, src, at };
    }
    return null;
}

// The mempool INSERT call site: base text lives in the entry
// (src/XChainDecoder.js); the decoder's constructor/method split moved it to
// src/XChainDecoder/mempool_refresh.js.
function readDecoderSite(decoderSrc) {
    const srcDir = path.dirname(decoderSrc);
    const mempoolPart = path.join(srcDir, 'XChainDecoder', 'mempool_refresh.js');
    const found = locateText([mempoolPart, decoderSrc], 'insertMempoolTransaction({');
    if (!found) {
        throw new Error('decoder mempool INSERT call site not found in ' + decoderSrc + ' or ' + mempoolPart);
    }
    // The assignment of the value bound to `data:` lives just above the call.
    const site = found.src.slice(Math.max(0, found.at - 2500), found.at + 600);
    return { src: found.src, at: found.at, site, sitePath: found.path };
}

// The storage-gate definition (buildStoredActionRecord): base text lives in the
// entry; the same split moved it to
// src/XChainDecoder/dispenser_and_oracle_fees.js.
function readDecoderGate(decoderSrc) {
    const srcDir = path.dirname(decoderSrc);
    const gatePart = path.join(srcDir, 'XChainDecoder', 'dispenser_and_oracle_fees.js');
    const found = locateText([gatePart, decoderSrc], 'buildStoredActionRecord(parseResult, txHash, mempool)');
    if (!found) {
        throw new Error('decoder storage gate buildStoredActionRecord not found in ' + decoderSrc + ' or ' + gatePart);
    }
    const gate = found.src.slice(found.at, found.at + 4000);
    return { gate, gateAt: found.at, gatePath: found.path };
}

module.exports = {
    fs, path, sinon, expect, ChangeDetector, Broadcaster, envView, mkDb, SEND_ROW,
    MINT_ROW, TRASH_ROW, LEGACY_HEX_ROW, getDecoderPaths, loadCanonicalizer,
    makeEncodingFixture, readDecoderSite, readDecoderGate
};
