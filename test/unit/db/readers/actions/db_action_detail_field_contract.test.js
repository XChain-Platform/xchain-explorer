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
 **********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const proxyquire = require('proxyquire');
const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../../fixtures/mock-query-args.js');
const { GENERIC_ROW } = require('../../../../fixtures/action-detail-capture.js');
const { REGISTRY, getHandler } = require('../../../../../src/action-detail');
const {
    loadIndexerSchema,
    assertIndexerQueryShape
} = require('../../../../../src/action-detail/indexer_schema_contract.js');

const configInfo = createConfigInfoStub();
const util = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

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
const INDEXER_SCHEMA = loadIndexerSchema(ROOT, process.env);

// A wildcard does not prove any particular output name. An action using one must
// state its stable output fields here. There are no wildcard detail SELECTs now.
const WILDCARD_SELECT_FIELDS = Object.freeze({});

// showIssueDetails computes these property names from a fixed loop.
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
            assertIndexerQueryShape(match[1], INDEXER_SCHEMA);
            for(const field of selectedFields(action, match[1])) fields.add(field);
        }
    }
    return fields;
}

function makeDb() {
    return new Database(mockExplorer);
}

async function captureDetail(action, actionFormat) {
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

    const result = await db.getActionData(config, 42);
    return { statements, result };
}

async function assertRendererContract(action, renderer) {
    const selected = supplementFields(action);
    const capturedDerived = new Set();
    let indexerFieldsChecked = 0;
    const formats = action === 'DEPLOY' ? [0, 4] : [0];
    for(const format of formats) {
        const capture = await captureDetail(action, format);
        for(const field of Object.keys(capture.result)) {
            if(!Object.prototype.hasOwnProperty.call(GENERIC_ROW, field)) capturedDerived.add(field);
        }
        for(const sql of capture.statements) {
            for(const field of selectedFields(action, sql)) selected.add(field);
            indexerFieldsChecked += assertIndexerQueryShape(sql, INDEXER_SCHEMA);
        }
    }

    assert.ok(indexerFieldsChecked > 0, action + ' did not check any field against the indexer schema');

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
}

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

    it('fails when an explorer field is absent from the indexer schema', function () {
        const schema = new Map(INDEXER_SCHEMA);
        schema.set('contract_stakes', new Set(INDEXER_SCHEMA.get('contract_stakes')));
        schema.get('contract_stakes').delete('target_contract_index');
        assert.throws(
            () => assertIndexerQueryShape(
                'SELECT m.target_contract_index FROM contract_stakes m WHERE m.action_index=?', schema
            ),
            /field absent from contract_stakes: target_contract_index/
        );
    });

    it('fails when the indexer field contract is unavailable', function () {
        const env = { XCHAIN_SIBLING_ROOT: path.join(ROOT, 'tmp', 'missing-siblings') };
        assert.throws(() => loadIndexerSchema(ROOT, env), /xchain-indexer src\/sql is required/);
    });

    for(const { action, renderer } of actionRenderers()) {
        it(action + ' provides every field read by ' + renderer, async function () {
            await assertRendererContract(action, renderer);
        });
    }

    it('covers exactly the registered actions that dispatch to these renderer modules', function () {
        const actions = actionRenderers().map(({ action }) => action);
        assert.ok(actions.length > 40, 'the dispatcher scan did not find the detail renderers');
        assert.deepStrictEqual(actions.filter((action) => !REGISTRY[action]), []);
    });
});

describe('action detail field contract: unqualified indexer fields', function () {
    it('fails when an unqualified explorer field is absent from the indexer schema', function () {
        const schema = new Map(INDEXER_SCHEMA);
        schema.set('contract_stakes', new Set(INDEXER_SCHEMA.get('contract_stakes')));
        schema.get('contract_stakes').delete('target_contract_index');
        assert.throws(
            () => assertIndexerQueryShape(
                'SELECT target_contract_index FROM contract_stakes WHERE action_index=?', schema
            ),
            /field absent from contract_stakes: target_contract_index/
        );
    });
});
