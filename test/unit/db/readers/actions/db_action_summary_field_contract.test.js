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
const { REGISTRY, getHandler } = require('../../../../../src/action-detail');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const { BATCH }    = require('../../../../../src/action-detail/misc.js');

const SRC = srcText('src/content/js/xchain.js');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DETAIL_DIR = path.join(ROOT, 'src', 'content', 'js', 'xchain', 'detail');
const HANDLER_DIR = path.join(ROOT, 'src', 'action-detail');
const SUPPLEMENT_SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'db', 'readers', 'action_detail_io', 'action_data.js'),
    'utf8'
);
const DETAIL_SOURCES = new Map(fs.readdirSync(DETAIL_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => [file, fs.readFileSync(path.join(DETAIL_DIR, file), 'utf8')]));

// A wildcard does not prove any particular output name. An action using one must
// state its stable output fields here. There are no wildcard detail SELECTs now.
const WILDCARD_SELECT_FIELDS = Object.freeze({});

// showIssueDetails computes these property names from a fixed loop. Keeping the
// expansion beside the scanner makes every real read visible to the assertion.
const COMPUTED_RENDERER_FIELDS = Object.freeze({
    showIssueDetails: Object.freeze([
        'lock_max_supply',
        'lock_max_mint',
        'lock_mint',
        'lock_mint_supply',
        'lock_description',
        'lock_sleep',
        'lock_callback'
    ])
});

const ACTION_SUPPLEMENTS = Object.freeze({
    ISSUE: Object.freeze(['attachIssueControllerFields']),
    DEPLOY: Object.freeze(['attachDeployChunkFields', 'attachDeployExecutionFields'])
});

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

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function stripSqlComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function extractFunction(source, name) {
    const start = source.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
    if(start < 0) throw new Error('function not found: ' + name);
    const closeParams = source.indexOf(')', start);
    const braceStart = source.indexOf('{', closeParams);
    let depth = 0;
    for(let i = braceStart; i < source.length; i++) {
        if(source[i] === '{') depth++;
        else if(source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('unterminated function: ' + name);
}

function declaredFunctions(sources) {
    const functions = new Map();
    for(const [file, source] of sources) {
        for(const match of source.matchAll(/(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
            const text = extractFunction(source, match[1]);
            const open = text.indexOf('(');
            const close = text.indexOf(')', open);
            const params = text.slice(open + 1, close).split(',').map((part) => part.trim());
            functions.set(match[1], { file, params, text });
        }
    }
    return functions;
}

const RENDERER_FUNCTIONS = declaredFunctions(DETAIL_SOURCES);

function actionRenderers() {
    const source = DETAIL_SOURCES.get('detail_core.js');
    const renderers = [];
    const dispatch = /o\.action\s*==\s*'([A-Z0-9_]+)'[^\n]*\b([a-zA-Z_$][\w$]*)\(o\)/g;
    for(const match of source.matchAll(dispatch)) {
        if(RENDERER_FUNCTIONS.has(match[2]))
            renderers.push({ action: match[1], renderer: match[2] });
    }
    return renderers;
}

function detailRendererFieldReads(renderer) {
    const reads = new Set();
    const seen = new Set();

    function visit(name, argumentIndex) {
        const visitKey = name + ':' + argumentIndex;
        if(seen.has(visitKey)) return;
        seen.add(visitKey);

        const fn = RENDERER_FUNCTIONS.get(name);
        if(!fn) return;
        const parameter = fn.params[argumentIndex];
        if(!/^[a-zA-Z_$][\w$]*$/.test(parameter || '')) return;
        const body = stripComments(fn.text);
        const fields = new RegExp('(?<![.\\w$])' + parameter + '((?:\\.[a-zA-Z_$][\\w$]*)+)', 'g');
        for(const match of body.matchAll(fields)) reads.add(match[1].slice(1));
        const brackets = new RegExp('(?<![.\\w$])' + parameter + '\\s*\\[([^\\]]+)\\]', 'g');
        for(const match of body.matchAll(brackets)) {
            const literal = match[1].trim().match(/^['"]([a-zA-Z_$][\w$]*)['"]$/);
            if(literal) {
                reads.add(literal[1]);
                continue;
            }
            assert.ok(Object.prototype.hasOwnProperty.call(COMPUTED_RENDERER_FIELDS, name),
                name + ' has a computed data field read without an explicit expansion');
            for(const field of COMPUTED_RENDERER_FIELDS[name]) reads.add(field);
        }

        for(const [helper] of RENDERER_FUNCTIONS) {
            const calls = new RegExp('\\b' + helper + '\\s*\\(([^)]*)\\)', 'g');
            for(const call of body.matchAll(calls)) {
                call[1].split(',').map((part) => part.trim()).forEach((argument, index) => {
                    if(argument === parameter) visit(helper, index);
                });
            }
        }
    }

    visit(renderer, 0);
    return reads;
}

function sqlSelectList(sql) {
    const clean = stripSqlComments(String(sql));
    const match = /\bSELECT\b/i.exec(clean);
    if(!match) return '';
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = null;
    for(let i = start; i < clean.length; i++) {
        const character = clean[i];
        if(quote) {
            if(character === quote && clean[i - 1] !== '\\') quote = null;
            continue;
        }
        if(character === "'" || character === '"' || character === '`') {
            quote = character;
        } else if(character === '(') {
            depth++;
        } else if(character === ')') {
            depth--;
        } else if(depth === 0 && /^FROM\b/i.test(clean.slice(i))) {
            return clean.slice(start, i);
        }
    }
    return clean.slice(start);
}

function splitSelectItems(selectList) {
    const items = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    for(let i = 0; i < selectList.length; i++) {
        const character = selectList[i];
        if(quote) {
            if(character === quote && selectList[i - 1] !== '\\') quote = null;
            continue;
        }
        if(character === "'" || character === '"' || character === '`') {
            quote = character;
        } else if(character === '(') {
            depth++;
        } else if(character === ')') {
            depth--;
        } else if(character === ',' && depth === 0) {
            items.push(selectList.slice(start, i));
            start = i + 1;
        }
    }
    items.push(selectList.slice(start));
    return items;
}

function selectedFields(action, sql, wildcardFields = WILDCARD_SELECT_FIELDS) {
    const fields = new Set();
    for(const rawItem of splitSelectItems(sqlSelectList(sql))) {
        const item = rawItem.trim();
        if(/^(?:[a-zA-Z_$][\w$]*\.)?\*$/.test(item)) {
            assert.ok(Object.prototype.hasOwnProperty.call(wildcardFields, action),
                action + ' uses a wildcard detail SELECT without an explicit field exception');
            for(const field of wildcardFields[action]) fields.add(field);
            continue;
        }
        const alias = item.match(/\s+as\s+[`"]?([a-zA-Z_$][\w$]*)[`"]?\s*$/i);
        const column = item.match(/(?:^|\.)[`"]?([a-zA-Z_$][\w$]*)[`"]?\s*$/);
        if(alias) fields.add(alias[1]);
        else if(column) fields.add(column[1]);
    }
    return fields;
}

const HANDLER_SOURCES = new Map(fs.readdirSync(HANDLER_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => [file, fs.readFileSync(path.join(HANDLER_DIR, file), 'utf8')]));
const HANDLER_HELPERS = declaredFunctions(HANDLER_SOURCES);

function handlerSetFields(handler) {
    const fields = new Set();
    const pending = Object.values(handler)
        .filter((value) => typeof value === 'function')
        .map((fn) => fn.toString());
    const seen = new Set();

    while(pending.length) {
        const source = stripComments(pending.pop());
        if(seen.has(source)) continue;
        seen.add(source);

        const assignment = /\bdata(?:\.([a-zA-Z_$][\w$]*)|\[['"]([a-zA-Z_$][\w$]*)['"]\])\s*=/g;
        for(const match of source.matchAll(assignment)) fields.add(match[1] || match[2]);
        for(const [name, fn] of HANDLER_HELPERS) {
            if(new RegExp('(?:\\b|\\.)' + name + '\\s*\\(').test(source)) pending.push(fn.text);
        }
    }
    return fields;
}

function supplementFields(action) {
    const fields = new Set();
    for(const name of ACTION_SUPPLEMENTS[action] || []) {
        const source = extractFunction(SUPPLEMENT_SOURCE, name);
        for(const match of source.matchAll(/`(SELECT[\s\S]*?)`/g)) {
            for(const field of selectedFields(action, match[1])) fields.add(field);
        }
    }
    return fields;
}

async function captureDetail(action, actionFormat) {
    const detailConfigInfo = createConfigInfoStub();
    const detailUtil = new Utility(detailConfigInfo);
    const db = new Database({ configInfo: detailConfigInfo, util: detailUtil });
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

    const result = await db.getActionData(config, 42);
    return { statements, result };
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
});

describe('action detail field contract: handler output vs detail renderers', function () {
    this.timeout(20000);

    it('discovers every action renderer under the detail directory', function () {
        const mapped = new Set(actionRenderers().map(({ renderer }) => renderer));
        const unmapped = [...RENDERER_FUNCTIONS]
            .map(([name]) => name)
            .filter((name) => /^show[A-Z].*Details$/.test(name) && !mapped.has(name))
            .sort();
        assert.deepStrictEqual(unmapped, [
            'showActionDetails',
            'showCustodyDetails',
            'showTransactionDetails'
        ]);
    });

    it('requires explicit output fields for wildcard SELECTs', function () {
        assert.throws(
            () => selectedFields('WILDCARD_TEST', 'SELECT row.* FROM rows row'),
            /without an explicit field exception/
        );
        assert.deepStrictEqual(
            [...selectedFields('WILDCARD_TEST', 'SELECT row.* FROM rows row', {
                WILDCARD_TEST: ['declared_field']
            })],
            ['declared_field']
        );
    });

    for(const { action, renderer } of actionRenderers()) {
        it(action + ' provides every field read by ' + renderer, async function () {
            const selected = supplementFields(action);
            const capturedDerived = new Set();
            const formats = action === 'DEPLOY' ? [0, 4] : [0];
            for(const format of formats) {
                const capture = await captureDetail(action, format);
                for(const field of Object.keys(capture.result)) {
                    if(!Object.prototype.hasOwnProperty.call(GENERIC_ROW, field)) capturedDerived.add(field);
                }
                for(const sql of capture.statements) {
                    for(const field of selectedFields(action, sql)) selected.add(field);
                }
            }

            const derived = handlerSetFields(getHandler(action));
            for(const field of capturedDerived) derived.add(field);
            const missing = [...detailRendererFieldReads(renderer)]
                .filter((fieldPath) => {
                    const topLevel = fieldPath.split('.')[0];
                    return !selected.has(topLevel) && !derived.has(topLevel);
                })
                .sort();

            assert.deepStrictEqual(missing, [],
                action + ' renderer reads fields absent from its SELECTs and handler: ' + missing.join(', '));
        });
    }

    it('covers exactly the registered actions that dispatch to these renderer modules', function () {
        const actions = actionRenderers().map(({ action }) => action);
        assert.ok(actions.length > 40, 'the dispatcher scan did not find the detail renderers');
        assert.deepStrictEqual(actions.filter((action) => !REGISTRY[action]), []);
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
