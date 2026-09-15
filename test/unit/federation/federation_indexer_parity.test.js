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
 * The explorer's five federation reads answer exactly as the indexer does.
 *
 * A validator with no DOGE indexer points its roll-call close, anchor reward check,
 * archive publisher and price-batch reconcile at the explorer, so every answer the
 * explorer gives must be the one the indexer would have given off the same rows.
 * This suite runs each fixture in support/parity_cases.js through the explorer's
 * method and through the indexer's OWN handler and accessors (loaded from the
 * sibling checkout), both over one scripted database, and asserts:
 *
 *   - the results are deep-equal, refusals and error strings included;
 *   - both sides sent the same statements (whitespace aside) with the same
 *     arguments, except the tip read, whose column alias differs by service;
 *   - the anchor statements are byte-identical to the indexer's constants.
 *
 * The sibling is resolved the way test/unit/repo/sibling_coverage.test.js resolves
 * it. Absent, the suite skips; XCHAIN_REQUIRE_SIBLINGS=1 turns that into a failure.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { explorerDb, indexerView } = require('./support/scripted_db.js');
const CASES = require('./support/parity_cases.js');

const { getrollcallsigners }     = require('../../../src/federation/rollcall_signers.js');
const { getanchoraction }        = require('../../../src/federation/anchor_action.js');
const { getanchorconfirmations } = require('../../../src/federation/anchor_confirmations.js');
const { getarchiveanchor }       = require('../../../src/federation/archive_anchor.js');
const { getpricebatches }        = require('../../../src/federation/price_batches.js');
const federationSql              = require('../../../src/db/federation_sql.js');

const REPO_ROOT    = path.join(__dirname, '..', '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const INDEXER      = path.join(SIBLING_ROOT, 'xchain-indexer');
const STRICT       = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// The indexer modules this suite drives, or the reason they could not be loaded.
function loadIndexer() {
    try {
        const req = (rel) => require(path.join(INDEXER, rel));
        return {
            rollcall: req('src/api/rpc/rollcall.js').buildRollcallRpc,
            anchor:   req('src/api/rpc/anchor.js').buildAnchorRpc,
            prices:   req('src/api/rpc/price_batches.js').buildPriceBatchesRpc,
            anchorSql: req('src/db/anchor_sql.js'),
            mixins: [req('src/db/blocks/index.js'), req('src/db/rollcalls/index.js'),
                     req('src/db/prices/price_log.js'), req('src/db/database/mirror_reads.js')],
            manifest: path.join(INDEXER, 'test', 'fixtures', 'action-manifest.json')
        };
    } catch (e) {
        return { error: e };
    }
}
const INDEXER_MODULES = loadIndexer();

// Skip or fail, per STRICT, when the indexer could not be loaded.
function requireIndexer() {
    if (!INDEXER_MODULES.error) return;
    const why = 'xchain-indexer not loadable at ' + INDEXER + ': ' + INDEXER_MODULES.error.message;
    if (STRICT) throw new Error(why);
    this.skip();
}

// The DOGE testnet coin both sides default to.
const DOGE_TESTNET = { code: 'TDOGE', COIN: 'DOGE', NETWORK: 'testnet' };

// The indexer's handler for a method, built over a view of the scripted database.
function indexerHandler(method, view, coin) {
    const m = INDEXER_MODULES;
    const indexer = { indexerDb: { apiView: () => view }, config: { COIN: coin.COIN, NETWORK: coin.NETWORK } };
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(m.manifest)).digest('hex');
    const all = Object.assign({}, m.rollcall({ indexer, rollcallManifestHash: hash }),
        m.anchor({ indexer }), m.prices({ indexer }));
    return all[method];
}

const EXPLORER_HANDLERS = { getrollcallsigners, getanchoraction, getanchorconfirmations, getarchiveanchor, getpricebatches };

// A recorded call with the one legitimately different statement blanked and the
// whitespace, which carries no meaning in SQL, collapsed.
function comparable(call) {
    if (call.kind === 'tip') return { kind: 'tip' };
    return { kind: call.kind, sql: String(call.sql).replace(/\s+/g, ' ').trim(), args: call.args };
}

// Run one case through both services and assert they agree.
async function assertParity(method, testCase) {
    const coin = testCase.coin || DOGE_TESTNET;
    const ourCalls = [], theirCalls = [];
    const db = explorerDb(testCase.scenario, ourCalls);
    const ctx = { db, dbConfig: { coin: coin.code, data: {} }, chain: { COIN: coin.COIN, NETWORK: coin.NETWORK } };
    const ours = await EXPLORER_HANDLERS[method](ctx, testCase.params);
    const view = indexerView(testCase.scenario, theirCalls, INDEXER_MODULES.mixins);
    const theirs = await indexerHandler(method, view, coin)(testCase.params);
    assert.deepStrictEqual(ours, theirs, method + ': results differ');
    assert.deepStrictEqual(ourCalls.map(comparable), theirCalls.map(comparable), method + ': statements differ');
    // The explorer's pool returns BIGINT as BigInt; an unconverted one would crash the JSON reply
    assert.doesNotThrow(() => JSON.stringify(ours), method + ': result is not JSON-serializable');
    return ours;
}

// One `it` per fixture, with the service loggers muted for the scripted failures.
function parityCases(method, cases) {
    for (const testCase of cases) {
        it(method + ' agrees on ' + testCase.name, async function () {
            requireIndexer.call(this);
            const mute = [sinon.stub(console, 'error'), sinon.stub(console, 'warn')];
            try { await assertParity(method, testCase); }
            finally { mute.forEach(s => s.restore()); }
        });
    }
}

describe('federation reads: getrollcallsigners parity with the indexer', function () {
    parityCases('getrollcallsigners', CASES.ROLLCALL_CASES);
});

describe('federation reads: getanchoraction parity with the indexer', function () {
    parityCases('getanchoraction', CASES.ACTION_CASES);
});

describe('federation reads: getanchorconfirmations parity with the indexer', function () {
    parityCases('getanchorconfirmations', CASES.CONFIRMATION_CASES);
});

describe('federation reads: getarchiveanchor parity with the indexer', function () {
    parityCases('getarchiveanchor', CASES.ARCHIVE_CASES);
});

describe('federation reads: getpricebatches parity with the indexer', function () {
    parityCases('getpricebatches', CASES.PRICE_CASES);
});

describe('federation reads: anchor statements are the indexer\'s, byte for byte', function () {
    const NAMES = ['CHECKPOINT_VERSIONS', 'CHECKPOINT_SECTION_VERSIONS', 'CHECKPOINT_SECTION_VERSIONS_SQL',
        'ANCHOR_ROW_LIMIT', 'ANCHOR_ACTIONS_SQL', 'ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL', 'ARCHIVE_ANCHOR_ROW_LIMIT',
        'ARCHIVE_ANCHOR_BY_CONTENT_SQL', 'ANCHOR_BY_TXID_COLUMNS', 'ANCHOR_BY_TXID_SQL', 'ANCHOR_BY_TXID_AFTER_SQL'];
    for (const name of NAMES) {
        it(name + ' matches', function () {
            requireIndexer.call(this);
            assert.deepStrictEqual(federationSql[name], INDEXER_MODULES.anchorSql[name]);
        });
    }

    it('the vendored manifest the roll-call hash reads is the indexer\'s', function () {
        requireIndexer.call(this);
        const ours = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'action-manifest.json'));
        assert.ok(ours.equals(fs.readFileSync(INDEXER_MODULES.manifest)), 'action-manifest.json differs from the indexer copy');
    });
});
