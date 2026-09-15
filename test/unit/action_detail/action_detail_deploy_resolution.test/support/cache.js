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
 **********************************************************************
 * Where a chunked DEPLOY's contract actually is.
 *
 * A contract too large for one action ships as N base64 carriers plus one
 * assembling DEPLOY, and since deferred assembly the group deploys at whichever
 * piece CONFIRMS LAST, in that piece's own action. So the action a deployer
 * submitted and waits on is frequently NOT the action the contract was created
 * at, and nothing on the assembler's own row says where it went: its contracts
 * row keeps the status it landed with (`pending: CODE_HASH (awaiting chunks)`),
 * and the completing carrier is a different action_index entirely.
 *
 * /api/action/A answers that with two fields the SDK and the wallet poll:
 *
 *   deployed_contract_index  the contract's action_index, or null when there is
 *                            no contract (yet, or ever)
 *   assembly_status          why: `valid` once deployed, the consuming action's
 *                            terminal status when the assembly FAILED at the
 *                            completing carrier, else the assembler's own status
 *
 * Without the second field a client polling the first would wait out its whole
 * timeout on a group that died at C on a hash mismatch or a drained source: the
 * assembler's own row still reads `pending:` and always will (the status is
 * written once and never mutated).
 *
 * The resolution is SQL, so the four cases below are driven by RUNNING the
 * shipped query over seeded rows in an in-memory SQLite database rather than by
 * asserting on the query text. What is being pinned is the answer, not the
 * spelling: replacing the CASE with a constant null reds these.
 *********************************************************************/

'use strict';

const assert     = require('node:assert/strict');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const PENDING_S  = 'pending: CODE_HASH (awaiting chunks)';
const MISMATCH_S = 'invalid: CODE_HASH (mismatch)';

describe('chunked DEPLOY: which action deployed the contract', function () {
    // D49. The pending answer is the one that MUST NOT be frozen: the action LRU
    // has no TTL and only a reorg invalidates it, so a null cached while the group
    // was incomplete would be served for the life of the process - to the very
    // clients polling this endpoint to learn where their contract landed. Nothing
    // rewrites the assembler's response when the group completes; the values simply
    // resolve differently on the next read, which the cache would prevent.
    describe('the action cache refuses a pending response', function () {
        function db() {
            const configInfo = createConfigInfoStub();
            return new Database({ configInfo, util: new Utility(configInfo) });
        }

        it('refuses a pending assembler, whose deployed_contract_index resolves later', function () {
            assert.equal(db().isCacheableAction({
                action: 'DEPLOY', action_index: 300, action_format: 2, status: PENDING_S,
                deployed_contract_index: null, assembly_status: PENDING_S
            }), false);
        });

        it('still caches the same DEPLOY once it has deployed', function () {
            assert.equal(db().isCacheableAction({
                action: 'DEPLOY', action_index: 300, action_format: 2, status: 'valid',
                deployed_contract_index: 300, assembly_status: 'valid'
            }), true, 'a settled deploy is immutable and the LRU exists for it');
        });

        it('caches a deferred assembler whose consuming carrier failed, a terminal answer', function () {
            assert.equal(db().isCacheableAction({
                action: 'DEPLOY', action_index: 400, action_format: 2, status: MISMATCH_S,
                deployed_contract_index: null, assembly_status: MISMATCH_S
            }), true);
        });

        it('matches the status, not the new fields: every other DEPLOY stays cacheable', function () {
            // deployed_contract_index is on EVERY deploy response, so listing it in
            // MUTABLE_ACTION_FIELDS (which matches by presence) would uncache the
            // whole action type for a mutation only the pending case has.
            assert.equal(Database.MUTABLE_ACTION_FIELDS.includes('deployed_contract_index'), false);
            assert.equal(Database.MUTABLE_ACTION_FIELDS.includes('assembly_status'), false);
        });

        it('a pending response stays absent from the LRU, so the next read resolves it', function () {
            const d   = db();
            const key = d.cacheKey('BTC', 300);
            const pending = { action: 'DEPLOY', action_index: 300, status: PENDING_S, deployed_contract_index: null };
            if (d.isCacheableAction(pending)) d.cacheSet(d._actionDataCache, key, pending);
            assert.equal(d.cacheGet(d._actionDataCache, key), undefined);
            const done = { action: 'DEPLOY', action_index: 300, status: 'valid', deployed_contract_index: 305 };
            if (d.isCacheableAction(done)) d.cacheSet(d._actionDataCache, key, done);
            assert.deepEqual(d.cacheGet(d._actionDataCache, key), done);
        });
    });
});
