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

const { srcText } = require('../../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const assert = require('assert');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../../fixtures/mock-query-args.js');
const { GENERIC_ROW } = require('../../../../fixtures/action-detail-capture.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const { REGISTRY, getHandler } = require('../../../../../src/action-detail');
const { BATCH } = require('../../../../../src/action-detail/misc.js');
const {
    loadIndexerSchema,
    assertIndexerQueryShape
} = require('../../../../../src/action-detail/indexer_schema_contract.js');

const SRC = srcText('src/content/js/xchain.js');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const INDEXER_SCHEMA = loadIndexerSchema(ROOT, process.env);

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
    const body = (extractFn('getActionDetails')
        + extractFn('actionDetail_renderBasicActions')
        + extractFn('actionDetail_renderMarketActions')
        + extractFn('actionDetail_renderMessageActions')
        + extractFn('actionDetail_renderContractActions')
        + extractFn('actionDetail_renderConsensusActions')).replace(/\/\/[^\n]*/g, '');
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

async function realSummaryQueries(action, actionFormat) {
    const db = makeDb();
    const config = makeConfig({ coin: 'BTC' });
    const statements = [];
    let call = 0;
    db.doQuery = async function(cfg, statement, args) {
        statements.push(String(statement));
        call++;
        if(call === 1) return [{ action }];
        if(/information_schema\.TABLES/i.test(statement))
            return (args || []).map((name) => ({ TABLE_NAME: name }));
        if(/information_schema\.COLUMNS/i.test(statement))
            return (args || []).map((name) => ({ COLUMN_NAME: name }));
        return [Object.assign({}, GENERIC_ROW, { action_format: actionFormat })];
    };

    const handler = getHandler(action);
    assert.strictEqual(handler, REGISTRY[action], action + ' must resolve through the registered handler');
    db.buildActionPreload = async () => null;
    await db.getActionSummaryData(config, [{ action_index: 42, action }]);
    return statements;
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
        // The identity the chain recorded rides the summary too: a history row
        // that carried only contract_index printed "Unnamed contract" for a named
        // contract (wallet regtest run, 2026-09-09) because these three never
        // left getActionData.
        const named = db.projectActionSummary({ action: 'DEPLOY', status: 'valid', action_index: 32, deployed_contract_index: 32, contract_meta_name: 'Escrow', contract_meta_version: '1.0.0' });
        expect(named.details).to.include({ deployed_contract_index: 32, contract_meta_name: 'Escrow', contract_meta_version: '1.0.0' });
        const call = db.projectActionSummary({ action: 'EXECUTE', status: 'valid', contract_index: 32, contract_meta_name: 'Escrow', contract_meta_version: null });
        expect(call.details).to.include({ contract_index: 32, contract_meta_name: 'Escrow', contract_meta_version: null });
        const vote = db.projectActionSummary({ action: 'VOTE', status: 'valid', vote_kind: 'yes' });
        expect(vote.details.vote_kind).to.equal('yes');
        const slash = db.projectActionSummary({ action: 'SLASH', status: 'valid', amount: '1', capability: 'validator' });
        expect(slash.details.capability).to.equal('validator');
    });

});

describe('action summary field contract: send and empty projections', function () {
    it('SEND projects sends[0] and falls back to its status', function () {
        const db = makeDb();
        const out = db.projectActionSummary({
            action: 'SEND', source: 'addrA',
            sends: [{ destination: 'addrB', tick: 'DANK', amount: '100', status: 'valid' }]
        });
        expect(out.status).to.equal('valid');
        expect(out.details).to.include({ destination: 'addrB', tick: 'DANK', amount: '100' });
    });

    it('permits the computed multi-leg total fields read by the renderer', function () {
        expect(Database.ACTION_SUMMARY_FIELDS).to.include.members(['leg_count', 'leg_total', 'mixed_tokens']);
        const out = makeDb().projectActionSummary({
            action: 'SEND',
            sends: [
                { destination: 'addrB', tick: 'DANK', amount: '1', status: 'valid' },
                { destination: 'addrC', tick: 'DANK', amount: '2', status: 'valid' }
            ]
        });
        expect(out.details).to.include({ leg_count: 2, leg_total: '3', mixed_tokens: false });
    });

    it('returns details false when no summary field is present', function () {
        const db = makeDb();
        const out = db.projectActionSummary({ action: 'ANCHOR', status: 'valid' });
        expect(out.details).to.equal(false);
        expect(out.status).to.equal('valid');
    });
});

describe('action summary field contract: indexer schema', function () {
    it('validates every real summary query against the indexer schema', async function () {
        let checked = 0;
        let queriedActions = 0;
        for(const action of Object.keys(REGISTRY)) {
            const formats = action === 'DEPLOY' ? [0, 4] : [0];
            for(const format of formats) {
                const statements = await realSummaryQueries(action, format);
                if(statements.length) queriedActions++;
                for(const statement of statements)
                    checked += assertIndexerQueryShape(statement, INDEXER_SCHEMA);
            }
        }
        assert.ok(queriedActions > 50, 'summary schema contract did not reach the registered queries');
        assert.ok(checked > 300, 'summary schema contract did not check the real query fields');
    });

    it('fails when a field in the real summary query is absent from the indexer schema', async function () {
        const statements = await realSummaryQueries('STAKE', 0);
        const statement = statements.find((sql) => /target_contract_index/.test(sql));
        assert.ok(statement, 'STAKE real summary query was not captured');
        const schema = new Map(INDEXER_SCHEMA);
        schema.set('contract_stakes', new Set(INDEXER_SCHEMA.get('contract_stakes')));
        schema.get('contract_stakes').delete('target_contract_index');
        assert.throws(
            () => assertIndexerQueryShape(statement, schema),
            /field absent from contract_stakes: target_contract_index/
        );
    });
});

describe('action summary field contract: projection vs getActionDetails', function () {
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
