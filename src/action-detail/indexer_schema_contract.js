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

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SQL_KEYWORDS = new Set([
    'where', 'inner', 'left', 'right', 'full', 'cross', 'join', 'on', 'union',
    'group', 'order', 'limit', 'having'
]);

function stripSqlComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function findIndexerRoot(explorerRoot, env = process.env) {
    const candidates = [];
    if(env.XCHAIN_SIBLING_ROOT) {
        candidates.push(path.join(env.XCHAIN_SIBLING_ROOT, 'xchain-indexer'));
    } else {
        for(let dir = explorerRoot; path.dirname(dir) !== dir; dir = path.dirname(dir))
            candidates.push(path.join(path.dirname(dir), 'xchain-indexer'));
    }
    return candidates.find((dir) => fs.existsSync(path.join(dir, 'src', 'sql', 'actions.sql'))) || null;
}

function loadIndexerSchema(explorerRoot, env) {
    const indexer = findIndexerRoot(explorerRoot, env);
    assert.ok(indexer, 'xchain-indexer src/sql is required for explorer field-shape parity');
    const schemaDir = path.join(indexer, 'src', 'sql');
    const tables = new Map();
    for(const file of fs.readdirSync(schemaDir).filter((name) => name.endsWith('.sql'))) {
        const source = stripSqlComments(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
        const table = source.match(/\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-zA-Z_$][\w$]*)`?\s*\(/i);
        if(!table) continue;
        const body = source.slice(table.index + table[0].length, source.search(/\)\s*ENGINE\s*=/i));
        const columns = new Set();
        for(const line of body.split('\n')) {
            const column = line.match(/^\s*`?([a-zA-Z_$][\w$]*)`?\s+[a-zA-Z]/);
            if(column && !/^(?:primary|unique|key|constraint|foreign|check)$/i.test(column[1]))
                columns.add(column[1]);
        }
        tables.set(table[1], columns);
    }
    assert.ok(tables.size > 100, 'indexer schema discovery did not load the real src/sql directory');
    return tables;
}

function queryTableAliases(sql) {
    const clean = stripSqlComments(String(sql));
    const aliases = new Map();
    const tables = /\b(?:FROM|JOIN)\s+`?([a-zA-Z_$][\w$]*)`?(?:\s+(?:AS\s+)?`?([a-zA-Z_$][\w$]*)`?)?/gi;
    for(const match of clean.matchAll(tables)) {
        let alias = match[2] && !SQL_KEYWORDS.has(match[2].toLowerCase()) ? match[2] : match[1];
        if(!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(match[1]);
    }
    return aliases;
}

function assertIndexerQueryShape(sql, schema) {
    const clean = stripSqlComments(String(sql));
    if(/\binformation_schema\./i.test(clean)) return 0;
    const aliases = queryTableAliases(clean);
    for(const tables of aliases.values()) {
        for(const table of tables)
            assert.ok(schema.has(table), 'explorer queries table absent from indexer schema: ' + table);
    }

    let checked = 0;
    for(const match of clean.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\.\s*`?([a-zA-Z_$][\w$]*)`?/g)) {
        if(!aliases.has(match[1])) continue;
        const tables = aliases.get(match[1]);
        assert.ok([...tables].some((table) => schema.get(table).has(match[2])),
            'explorer queries indexer field absent from ' + [...tables].join('/') + ': ' + match[2]);
        checked++;
    }
    return checked;
}

module.exports = { loadIndexerSchema, assertIndexerQueryShape };
