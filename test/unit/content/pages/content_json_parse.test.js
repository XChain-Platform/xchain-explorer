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
 * Static JSON assets under src/content/json must stay parseable.
 *
 * These files are served verbatim by the express.static mount in
 * XChainExplorer.js and parsed in the browser, not by the server, so a syntax
 * error never trips a startup check or any other suite. One trailing comma in
 * a served spec blanks the Swagger API-docs page for every visitor, because
 * the browser parser rejects it.
 *
 * The hand-kept xchain-platform-api.json stays on disk because a sibling
 * repo's contract test reads it by path, so it is parsed here like every
 * other shipped asset even though the docs page no longer loads it.
 *
 * This harness parses every shipped .json asset with the same strict
 * JSON.parse the browser uses, and pins the shape of the OpenAPI document the
 * docs page loads: the generated docs/openapi.json, served at /openapi.json.
 *
 * Run: mocha test/unit/content/pages/content_json_parse.test.js --timeout 0
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const JSON_DIR = path.join(REPO, 'src', 'content', 'json');
const SENTINEL_FILE = 'platform-links.json';
const OPENAPI_PATH = path.join(REPO, 'docs', 'openapi.json');

// V8 reports a byte offset but not always a line, so derive one when it is
// missing: a failure should name the line to fix, not a position in a 4000-line
// file.
function locate(text, error) {
    if (/line \d+/.test(error.message)) return error.message;
    const match = /position (\d+)/.exec(error.message);
    if (!match) return error.message;
    const before = text.slice(0, Number(match[1]));
    return `${error.message} (line ${before.split('\n').length}, column ${Number(match[1]) - before.lastIndexOf('\n')})`;
}

describe('src/content/json static assets', function () {
    const files = fs.readdirSync(JSON_DIR).filter((f) => f.endsWith('.json'));

    it('ships at least one JSON asset (guards against a moved directory)', function () {
        expect(files).to.include(SENTINEL_FILE);
    });

    files.forEach(function (file) {
        it(`${file} parses as strict JSON`, function () {
            const text = fs.readFileSync(path.join(JSON_DIR, file), 'utf8');
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (err) {
                throw new Error(`${file} is not valid JSON: ${locate(text, err)}`);
            }
            expect(parsed).to.be.an('object');
        });
    });
});

describe('docs/openapi.json, the spec the API docs page loads', function () {
    let spec;

    before(function () {
        spec = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    });

    it('is an OpenAPI 3.x document with the sections the docs page renders', function () {
        expect(spec.openapi).to.match(/^3\./);
        expect(spec.info).to.be.an('object');
        expect(spec.info.title).to.be.a('string').and.not.empty;
        expect(spec.paths).to.be.an('object');
        expect(Object.keys(spec.paths).length).to.be.greaterThan(0);
    });

    it('resolves every local $ref it declares', function () {
        const refs = new Set();
        (function walk(node) {
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                if (key === '$ref' && typeof value === 'string') refs.add(value);
                else walk(value);
            }
        })(spec);

        const missing = [...refs].filter((ref) => {
            if (!ref.startsWith('#/')) return false; // external refs are out of scope
            return ref.slice(2).split('/').reduce(
                (node, segment) => (node && typeof node === 'object'
                    ? node[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
                    : undefined),
                spec
            ) === undefined;
        });
        expect(missing, `unresolved $ref(s): ${missing.join(', ')}`).to.deep.equal([]);
    });
});
