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
 * Drift guard: docs/openapi.json must stay in lockstep with the `api` route
 * table in src/XChainExplorer.js and the special pre-wildcard app.get()
 * registrations. If you add/remove/rename a route, regenerate the spec
 * (node docs/openapi.build.js); this test fails until both sides match.
 */

'use strict';

const { srcText } = require('../helpers/source_text');

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const SRC  = srcText('src/XChainExplorer.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openapi.json'), 'utf8'));

// '/{COIN}/api/...' object keys inside the urls.api table in the source.
function sourceApiRoutes() {
    const out = new Set();
    for (const m of SRC.matchAll(/'(\/\{COIN\}\/api\/[^']*)'\s*:/g)) out.add(m[1]);
    return out;
}

// app.get('/:coin/api/...') and app.post('/:coin/api/...') registrations,
// normalized to the spec's template style (:coin -> {COIN}, :actionIndex ->
// {ACTION_INDEX}). Both verbs, because a route can be registered POST-only
// (the contract-call simulation route carries no GET at all), which a
// GET-only extractor cannot see (row M1.8).
function sourceSpecialRoutes() {
    const out = new Set();
    for (const m of SRC.matchAll(/app\.(?:get|post)\('(\/:coin\/api\/[^']*)'/g)) {
        out.add(m[1].replace(/:([A-Za-z]+)/g, (_s, name) =>
            '{' + name.replace(/([A-Z])/g, '_$1').toUpperCase() + '}'));
    }
    return out;
}

const specTable   = new Set();
const specSpecial = new Set();
for (const [p, def] of Object.entries(SPEC.paths))
    (def['x-registered'] === 'express' ? specSpecial : specTable).add(p);

function registerRouteTableTests() {

    it('documents every urls.api table route (and nothing extra)', () => {
        const src = sourceApiRoutes();
        expect(src.size).to.be.greaterThan(50, 'source route extraction looks broken');
        const missing = [...src].filter((p) => !specTable.has(p));
        const extra   = [...specTable].filter((p) => !src.has(p));
        expect(missing, 'routes missing from docs/openapi.json (run: node docs/openapi.build.js)').to.deep.equal([]);
        expect(extra, 'spec documents routes that no longer exist in src/XChainExplorer.js').to.deep.equal([]);
    });

    it('documents every special pre-wildcard api route', () => {
        const src = sourceSpecialRoutes();
        expect(src.size).to.be.greaterThan(2, 'special route extraction looks broken');
        const missing = [...src].filter((p) => !specSpecial.has(p));
        const extra   = [...specSpecial].filter((p) => !src.has(p));
        expect(missing, 'special routes missing from docs/openapi.json').to.deep.equal([]);
        expect(extra, 'spec documents special routes that no longer exist').to.deep.equal([]);
    });

}

describe('openapi.json route coverage', () => {
    registerRouteTableTests();
});

function registerSdkProducerTests() {
    it('every path has operationId, tag, summary, and error responses', () => {
        // Method-agnostic: a path documents GET, POST, or both (the contract-call
        // simulation route is POST-only), so this checks whichever operations are
        // actually present rather than assuming def.get exists.
        for (const [p, def] of Object.entries(SPEC.paths)) {
            const methods = ['get', 'post'].filter((m) => def[m]);
            expect(methods.length, `${p} must define GET and/or POST`).to.be.greaterThan(0);
            for (const m of methods) {
                const op = def[m];
                expect(op.operationId, `${p} ${m} operationId`).to.be.a('string').and.not.empty;
                expect(op.tags, `${p} ${m} tags`).to.be.an('array').with.lengthOf(1);
                expect(op.summary, `${p} ${m} summary`).to.be.a('string').and.not.empty;
                expect(op.responses['200'], `${p} ${m} 200 response`).to.exist;
                expect(op.responses['400'], `${p} ${m} 400 response`).to.exist;
            }
        }
    });

    it('declares the raw-file endpoint as binary, not a JSON list', () => {
        // processFileRawRequest answers octet-stream (or the file's own render-safe type)
        // and reads no query params, so the spec must not describe it with the generic
        // default (a ListResponse plus page/limit/sortorder).
        const op = SPEC.paths['/{COIN}/api/file/{ACTION_INDEX}/raw'].get;
        const c  = op.responses['200'].content;
        expect(c).to.have.property('application/octet-stream');
        expect(c).to.not.have.property('application/json');
        expect(op.parameters.map((p) => p.name || p.$ref)).to.not.include.members(['page', 'limit', 'sortorder']);
    });

    it('describes the gated ciphertext layout in the order the bytes are actually written', () => {
        // The published spec said "12-byte nonce || AES-256-GCM ciphertext || 16-byte tag"
        // while every producer writes the tag SECOND. The bytes are served untouched, so
        // nothing here goes red on its own: an implementer writing a decryptor from the
        // API docs slices the tag off the wrong end and fails GCM auth on every file.
        const description = SPEC.paths['/{COIN}/api/file/{ACTION_INDEX}/raw']
            .get.responses['200'].description;

        const nonce      = description.indexOf('12-byte nonce');
        const tag        = description.search(/16-byte[^|]*(tag|authentication tag)/);
        const ciphertext = description.indexOf('ciphertext');
        expect(nonce, 'nonce not described').to.be.greaterThan(-1);
        expect(tag, 'tag not described').to.be.greaterThan(-1);
        expect(ciphertext, 'ciphertext not described').to.be.greaterThan(-1);
        expect(nonce).to.be.lessThan(tag);
        expect(tag, 'the tag precedes the ciphertext on the wire').to.be.lessThan(ciphertext);
    });

}

describe('openapi.json route coverage', () => {
    registerSdkProducerTests();
});

// The doc string asserted above is derived from the producer rather than
// independently true, so an unreachable producer must not pass unnoticed: CI
// declares xchain-sdk in .ci-siblings and runs with XCHAIN_REQUIRE_SIBLINGS=1,
// where a missing encoder fails by name, and a standalone explorer clone records
// a pending case instead of a silent green.
function registerGatedFileProducerTests() {
    describe('the SDK producer still writes the documented byte order', gatedFileProducerSuite);
}

function gatedFileProducerSuite() {
        const SDK_GATED_FILE = process.env.XCHAIN_SDK_DIR
            ? path.join(process.env.XCHAIN_SDK_DIR, 'src', 'gatedFile.js')
            : path.resolve(__dirname, '../../../xchain-sdk/src/gatedFile.js');

        // The SDK keeps its old import paths alive as bare re-export shims, so the
        // pinned path can be four lines that carry no crypto at all. Reading it
        // directly would turn a moved module into a content failure here, and
        // fattening the shim to satisfy this check would mean two implementations
        // of one module. Follow the re-export to the module that really holds the
        // bytes, and assert against THAT source.
        function resolveModule(start) {
            const BARE_REEXPORT = /^\s*module\.exports\s*=\s*require\(\s*['"](\.[^'"]*)['"]\s*\)\s*;?\s*$/m;
            let current = start;
            // Two hops is one shim plus one re-spelling; a longer chain is a
            // layout the explorer should not be silently following.
            for (let hop = 0; hop <= 2; hop++) {
                const source = fs.readFileSync(current, 'utf8');
                // Strip comments so a shim's header banner cannot hide the body,
                // and so a mention of require() inside prose cannot fake one.
                const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                const m = body.match(BARE_REEXPORT);
                // Anything other than a lone re-export statement is the real module.
                if (!m || body.replace(m[0], '').trim() !== '') return { path: current, source };
                // Read to resolve, never existsSync to decide: an unreadable target
                // must fail by name here, not turn this case quiet.
                const target = path.resolve(path.dirname(current), m[1]);
                const next = [target, target + '.js'].find((p) => {
                    try { fs.readFileSync(p); return true; } catch { return false; }
                });
                if (!next)
                    throw new Error('the gated-file re-export at ' + current + ' points at ' + m[1] +
                        ', which does not exist; the SDK layout moved without a working shim');
                current = next;
            }
            throw new Error('the gated-file re-export chain from ' + start +
                ' did not reach a real module within 2 hops');
        }

        before(function () {
            if (!fs.existsSync(SDK_GATED_FILE)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-sdk gated-file encoder ' +
                        'was not found at ' + SDK_GATED_FILE);
                this.skip();
            }
        });

        it('concatenates [iv][authTag][ciphertext]', function () {
            const producer = resolveModule(SDK_GATED_FILE);
            expect(producer.source, 'the SDK stopped writing [iv][authTag][ciphertext] at ' +
                producer.path + '; the 200-response doc string follows the producer, so re-derive ' +
                'it before editing the layout assertion above')
                .to.match(/Buffer\.concat\(\[\s*iv\s*,\s*authTag\s*,\s*encrypted\s*\]\)/);
        });
}

describe('openapi.json route coverage', () => {

    it('declares the checkpoint routes with their real body and params', () => {
        // Both answer {checkpoints, count}, not the {total, data} list envelope, and
        // /checkpoints/range hard-requires from/to (400 INVALID_RANGE).
        for (const p of ['/{COIN}/api/checkpoints', '/{COIN}/api/checkpoints/range'])
            expect(SPEC.paths[p].get.responses['200'].content['application/json'].schema.$ref,
                `${p} 200 schema`).to.equal('#/components/schemas/CheckpointListResponse');

        const req = SPEC.paths['/{COIN}/api/checkpoints/range'].get.parameters;
        for (const name of ['from', 'to'])
            expect(req.find((q) => q.name === name), `${name} param`).to.include({ in: 'query', required: true });
        expect(req.map((q) => q.name)).to.not.include.members(['page', 'limit', 'sortorder']);
    });

    it('operationIds are unique', () => {
        // d.get.operationId alone TypeErrors on a POST-only path (contract-call has no
        // GET), and would also miss a genuine GET+POST collision, so collect both.
        const ids = [];
        for (const d of Object.values(SPEC.paths)) {
            if (d.get)  ids.push(d.get.operationId);
            if (d.post) ids.push(d.post.operationId);
        }
        expect(new Set(ids).size).to.equal(ids.length);
    });

    it('every {TYPE} parameter enum matches the source table', () => {
        // Re-extract the per-route type arrays from the source and compare.
        for (const m of SRC.matchAll(/'(\/\{COIN\}\/api\/[^']*\{TYPE\})'\s*:\s*\[\s*'[^']+'\s*,\s*(\[[^\]]*\])/g)) {
            const route = m[1];
            const types = JSON.parse(m[2].replace(/'/g, '"'));
            const param = (SPEC.paths[route].get.parameters || []).find((p) => p.name === 'TYPE');
            expect(param, `${route} TYPE param`).to.exist;
            expect(param.schema.enum, `${route} TYPE enum`).to.have.members(types);
        }
    });
});

describe('openapi.json route coverage', () => {
    registerGatedFileProducerTests();
});
