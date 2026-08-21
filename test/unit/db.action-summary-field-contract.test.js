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
 * The compact action summary (transaction/history rows, BATCH member table) is
 * one projection, db.projectActionSummary over ACTION_SUMMARY_FIELDS, and the
 * client's getActionDetails reads ONLY fields that projection carries. Two
 * drifts shipped before this guard existed: the staking/contract summary
 * branches read target_contract_index / method_name / contract_index / ... that
 * the whitelist never projected (contract STAKEs labeled 'capability stake',
 * EXECUTE linking /contract/undefined), and BATCH members bypassed the
 * projection entirely so a SEND child (fields under sends[]) rendered blank.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });
const { BATCH }    = require('../../src/action-detail/misc.js');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');

// Slice a top-level function out of the client source by walking braces.
function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

// Every `info.<field>` the shipped summary renderer reads, comments stripped so
// a prose mention (the BROADCAST note about info.fee) is not counted as a read.
function rendererFieldReads() {
    const body = extractFn('getActionDetails').replace(/\/\/[^\n]*/g, '');
    const reads = new Set();
    for (const m of body.matchAll(/\binfo\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) reads.add(m[1]);
    return reads;
}

// Fields the renderer reads off the nested SEND fallback (info.sends[]) rather
// than the projection; the projection flattens sends[0] so these are covered
// by the SEND special-case, not by the whitelist.
const NESTED_ONLY = new Set(['sends']);

function makeDb() {
    return new Database(mockExplorer);
}

describe('action summary field contract: projection vs getActionDetails', function () {

    it('every field getActionDetails reads is in ACTION_SUMMARY_FIELDS', function () {
        const reads = rendererFieldReads();
        expect(reads.size).to.be.greaterThan(20); // the regex found the real body
        const missing = [...reads].filter((f) => !NESTED_ONLY.has(f) && !Database.ACTION_SUMMARY_FIELDS.includes(f));
        expect(missing, 'getActionDetails reads fields the summary projection never carries').to.deep.equal([]);
    });

    it('[REGRESSION] staking/contract summary fields are projected', function () {
        const db = makeDb();
        const stake = db.projectActionSummary({ action: 'STAKE', status: 'valid', amount: '5', target_contract_index: 77 });
        expect(stake.details.target_contract_index).to.equal(77);
        const unstake = db.projectActionSummary({ action: 'UNSTAKE', status: 'valid', amount: '5', cooldown_end_block: 900 });
        expect(unstake.details.cooldown_end_block).to.equal(900);
        const exec = db.projectActionSummary({ action: 'EXECUTE', status: 'valid', method_name: 'mint', contract_index: 12 });
        expect(exec.details.method_name).to.equal('mint');
        expect(exec.details.contract_index).to.equal(12);
        const deploy = db.projectActionSummary({ action: 'DEPLOY', status: 'valid', action_index: 31, action_format: 4, chunk_index: 1, total_chunks: 3, cooldown_blocks: 10 });
        expect(deploy.details).to.include({ action_index: 31, chunk_index: 1, total_chunks: 3, cooldown_blocks: 10 });
        const vote = db.projectActionSummary({ action: 'VOTE', status: 'valid', vote_kind: 'yes' });
        expect(vote.details.vote_kind).to.equal('yes');
        const slash = db.projectActionSummary({ action: 'SLASH', status: 'valid', amount: '1', capability: 'validator' });
        expect(slash.details.capability).to.equal('validator');
    });

    it('SEND projects sends[0] and falls back to its status', function () {
        const db = makeDb();
        const out = db.projectActionSummary({
            action: 'SEND', source: 'addrA',
            sends: [{ destination: 'addrB', tick: 'DANK', amount: '100', status: 'valid' }]
        });
        expect(out.status).to.equal('valid');
        expect(out.details).to.include({ destination: 'addrB', tick: 'DANK', amount: '100' });
    });

    it('returns details false when no summary field is present', function () {
        const db = makeDb();
        const out = db.projectActionSummary({ action: 'ANCHOR', status: 'valid' });
        expect(out.details).to.equal(false);
        expect(out.status).to.equal('valid');
    });

    it('[REGRESSION] BATCH members carry the projection under summary, never on details', async function () {
        const db = makeDb();
        const members = new Map([
            [1, { action: 'SEND', action_index: 1, source: 'addrA',
                  sends: [{ destination: 'addrB', tick: 'DANK', amount: '100', status: 'valid' }] }],
            [2, { action: 'BET', action_index: 2, status: 'valid', details: 'eyJ4IjoxfQ==', bet_kind: 'feed' }],
            [3, { action: 'STAKE', action_index: 3, status: 'valid', amount: '5', target_contract_index: 77 }]
        ]);
        db.getActionDataBatch = async () => members;
        const data = {};
        await BATCH.afterQuery2({ db, config: {} }, data, [{ action_index: 1 }, { action_index: 2 }, { action_index: 3 }]);

        expect(data.actions.map((m) => m.action)).to.deep.equal(['SEND', 'BET', 'STAKE']);
        // SEND child: flat tick/amount/destination under summary, status from sends[0].
        expect(data.actions[0].summary).to.include({ destination: 'addrB', tick: 'DANK', amount: '100' });
        expect(data.actions[0].status).to.equal('valid');
        // BET feed member keeps its raw base64 DETAILS string untouched.
        expect(data.actions[1].details).to.equal('eyJ4IjoxfQ==');
        expect(data.actions[1].summary).to.be.an('object');
        // Existing status is never overwritten.
        expect(data.actions[2].status).to.equal('valid');
        expect(data.actions[2].summary.target_contract_index).to.equal(77);
    });
});
