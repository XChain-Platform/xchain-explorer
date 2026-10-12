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
const KEY_FIELDS = require('../../../../fixtures/action-summary-key-fields.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const governanceSql = require('../../../../../src/db/action_detail/governance_sql.js');
const consensusSql = require('../../../../../src/db/action_detail/consensus_sql.js');
const xbridgeSql = require('../../../../../src/db/action_detail/xbridge_sql.js');
const dispensersSql = require('../../../../../src/db/action_detail/dispensers_sql.js');
const ACTION_SOURCES = Object.freeze({
    BET_EXPIRE: Object.freeze({
        sql: Object.freeze([governanceSql.BET_EXPIRE_DETAIL, governanceSql.BET_EXPIRE_REFUNDS]),
        handler: require('../../../../../src/action-detail/governance.js').BET_EXPIRE,
        handlerPath: path.join(ROOT, 'src', 'action-detail', 'governance.js')
    }),
    ROLLCALL: Object.freeze({
        sql: Object.freeze([consensusSql.ROLLCALL_DETAIL, consensusSql.ROLLCALL_GATES, consensusSql.ROLLCALL_SIGNERS]),
        handler: require('../../../../../src/action-detail/consensus.js').ROLLCALL,
        handlerPath: path.join(ROOT, 'src', 'action-detail', 'consensus.js')
    }),
    XBRIDGE: Object.freeze({
        sql: Object.freeze([xbridgeSql.XBRIDGE_RECORD, xbridgeSql.XBRIDGE_SETTLEMENT]),
        handler: require('../../../../../src/action-detail/tokens.js').XBRIDGE,
        handlerPath: path.join(ROOT, 'src', 'action-detail', 'tokens.js')
    }),
    COINPAY_EXPIRE: Object.freeze({
        sql: Object.freeze([dispensersSql.COINPAY_EXPIRE_QUERY]),
        handler: require('../../../../../src/action-detail/dispensers.js').COINPAY_EXPIRE,
        handlerPath: path.join(ROOT, 'src', 'action-detail', 'dispensers.js')
    })
});

function selectedFields(statements) {
    const fields = new Set();
    for(const sql of statements) {
        const select = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i);
        if(!select) continue;
        for(const rawItem of select[1].split(',')) {
            const item = rawItem.trim();
            const alias = item.match(/\s+as\s+[`"]?([a-zA-Z_$][\w$]*)[`"]?\s*$/i);
            const column = item.match(/(?:^|\.)[`"]?([a-zA-Z_$][\w$]*)[`"]?\s*$/);
            if(alias) fields.add(alias[1]);
            else if(column) fields.add(column[1]);
        }
    }
    return fields;
}

function extractFunction(source, name) {
    const start = source.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    for(let i = braceStart; i < source.length; i++) {
        if(source[i] === '{') depth++;
        else if(source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('unterminated function: ' + name);
}

function handlerSetFields(handler, handlerPath) {
    const fields = new Set();
    const source = fs.readFileSync(handlerPath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const helpers = new Map();
    for(const match of source.matchAll(/(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g))
        helpers.set(match[1], extractFunction(source, match[1]));
    const pending = Object.values(handler)
        .filter((value) => typeof value === 'function')
        .map((fn) => fn.toString());
    const seen = new Set();
    const assignment = /\bdata(?:\.([a-zA-Z_$][\w$]*)|\[['"]([a-zA-Z_$][\w$]*)['"]\])\s*=/g;
    while(pending.length) {
        const handlerSource = pending.pop();
        if(seen.has(handlerSource)) continue;
        seen.add(handlerSource);
        for(const match of handlerSource.matchAll(assignment)) fields.add(match[1] || match[2]);
        for(const [name, helperSource] of helpers) {
            if(new RegExp('(?:\\b|\\.)' + name + '\\s*\\(').test(handlerSource))
                pending.push(helperSource);
        }
    }
    return fields;
}

function missingFields(action, fields) {
    const source = ACTION_SOURCES[action];
    const provided = selectedFields(source.sql);
    for(const field of handlerSetFields(source.handler, source.handlerPath)) provided.add(field);
    return fields.filter((field) => !provided.has(field));
}

describe('action summary key-fields fixture', function () {
    it('names the four intended action types with nonempty, unique field lists', function () {
        assert.deepStrictEqual(Object.keys(KEY_FIELDS).sort(), Object.keys(ACTION_SOURCES).sort());
        for(const [action, fields] of Object.entries(KEY_FIELDS)) {
            assert.ok(Array.isArray(fields) && fields.length > 0, action + ' must name key fields');
            assert.strictEqual(new Set(fields).size, fields.length, action + ' repeats a key field');
        }
    });

    for(const [action, fields] of Object.entries(KEY_FIELDS)) {
        it(action + ' key fields come from detail SQL or its handler', function () {
            assert.deepStrictEqual(missingFields(action, fields), []);
        });
    }

    it('rejects a field absent from both the detail SQL and handler', function () {
        assert.deepStrictEqual(missingFields('ROLLCALL', ['not_a_detail_field']), ['not_a_detail_field']);
    });
});
