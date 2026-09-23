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
 * Drift guard: the published row schemas must name exactly the columns the
 * readers select.
 *
 * docs/openapi.schemas.js declares one row schema per list reader. Each reader
 * is run here for real (only doQuery is stubbed, so it returns its query text),
 * the top-level select list is read off that text, and the column names are
 * compared with the schema's properties both ways. A column added to, dropped
 * from or renamed in a query fails here until its row schema moves with it.
 *
 * The committed docs/openapi.json is also held to the schemas module, so an
 * edit that skips `node docs/openapi.build.js` fails here rather than shipping
 * a docs page that disagrees with the source.
 *********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig }           = require('../../fixtures/mock-query-args.js');
const SCHEMAS = require('../../../docs/openapi.schemas.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'openapi.json'), 'utf8'));

// Readers that compose their rows in JavaScript rather than returning query text.
const COMPOSED = new Set(['getHistory', 'getMarkets', 'getMarketHistory', 'getMarketOrders']);

// Typed 200 operations the spec publishes; a ratchet, raise it when a route gains a schema.
const TYPED_200_FLOOR = 68;

// Split on commas that sit outside every parenthesis.
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; } else current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts.map((p) => p.trim());
}

// The column names of a query's outermost select list, in order.
function selectedColumns(queryText) {
    const text = queryText.replace(/--[^\n]*/g, '');
    const head = /^\s*select\b/i.exec(text);
    expect(head, 'reader query does not start with a select list').to.not.equal(null);
    let depth = 0;
    let end = -1;
    for (let i = head[0].length; i < text.length && end < 0; i++) {
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        if (depth === 0 && /\bfrom\b/i.test(text.slice(i, i + 5)) && /\s/.test(text[i - 1])) end = i;
    }
    return splitTopLevel(text.slice(head[0].length, end)).map((item) => {
        const alias = /\bas\s+(\w+)\s*$/i.exec(item);
        return alias ? alias[1] : item.split('.').pop();
    });
}

async function readerColumns(db, method) {
    const config = makeConfig({ coin: 'BTC' });
    config.data.method = method;
    config.data.search = '1';
    config.data.type = 'block';
    config.data.sql.where.data = '1=1';
    const [query] = await db[method](config);
    expect(query, `${method} no longer returns query text`).to.be.a('string');
    return selectedColumns(query);
}

function schemaFor(method) {
    return SCHEMAS.COMPONENT_SCHEMAS[SCHEMAS.ROW_SCHEMAS[method]];
}

function typed200Count() {
    const generic = new Set(['#/components/schemas/ListResponse', '#/components/schemas/ObjectResponse']);
    let count = 0;
    for (const item of Object.values(SPEC.paths))
        for (const op of [item.get, item.post].filter(Boolean)) {
            const json = (op.responses['200'].content || {})['application/json'];
            if (!json || !(json.schema.$ref && generic.has(json.schema.$ref))) count++;
        }
    return count;
}

describe('openapi row schemas match the reader select lists', function () {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = async () => [];

    const methods = Object.keys(SCHEMAS.ROW_SCHEMAS).filter((m) => !COMPOSED.has(m));

    it('covers every list reader the schemas module names', function () {
        expect(methods.length).to.be.greaterThan(35, 'row schema table looks truncated');
        for (const m of methods) expect(db[m], `${m} is not a Database method`).to.be.a('function');
    });

    methods.forEach(function (method) {
        it(`${method} selects exactly the ${SCHEMAS.ROW_SCHEMAS[method]} properties`, async function () {
            const columns = await readerColumns(db, method);
            const added = (SCHEMAS.POST_PASS_COLUMNS[method] || []);
            const declared = Object.keys(schemaFor(method).properties).filter((p) => !added.includes(p));
            expect([...columns].sort(), `${method} columns vs schema`).to.deep.equal([...declared].sort());
        });
    });
});

describe('docs/openapi.json carries the schemas module', function () {
    it('publishes every component schema byte-for-byte as the module builds it', function () {
        for (const [name, schema] of Object.entries(SCHEMAS.COMPONENT_SCHEMAS))
            expect(SPEC.components.schemas[name], `${name} (run: node docs/openapi.build.js)`).to.deep.equal(schema);
    });

    it('types the 200 body of every route a schema is keyed to', function () {
        const expected = [...Object.keys(SCHEMAS.ROW_SCHEMAS), ...Object.keys(SCHEMAS.BODY_SCHEMAS)];
        for (const method of expected) expect(SCHEMAS.responseSchema(method), method).to.not.equal(null);
        expect(typed200Count()).to.be.at.least(TYPED_200_FLOOR);
    });
});
