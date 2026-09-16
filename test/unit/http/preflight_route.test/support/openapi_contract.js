/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Unit tests for XChainExplorer.processPreflightRequest: the
 * input-validation + proxy shape of the public /{COIN}/api/preflight
 * route, exercised without a DB by calling the method on a minimal
 * `this` and asserting the mock res. Mirrors the sibling
 * processFeeQuoteRequest hardening.
 */

'use strict';

const { expect } = require('chai');
const XChainExplorer = require('../../../../../src/XChainExplorer.js');
const { batchParams } = require('./helpers.js');

// The published contract, not the implementation. The generator gave every
// pre-wildcard route the paginated-list treatment, so preflight shipped
// documented as taking page/limit/sortorder and returning {total, data} when it
// in fact takes `action` and returns one verdict object. These assertions pin
// the corrected entry against a silent regression on the next regeneration.
describe('preflight OpenAPI contract', function () {
    const spec = require('../../../../../docs/openapi.json');
    const op = spec.paths['/{COIN}/api/preflight'].get;
    const names = op.parameters.map((p) => p.name).filter(Boolean);

    it('documents the query parameters the route actually reads', function () {
        expect(names).to.have.members(['action', 'params', 'source', 'feeMode']);
        const feeMode = op.parameters.find((p) => p.name === 'feeMode');
        expect(feeMode.required).to.equal(false);
        expect(feeMode.schema.enum).to.have.members(['xchain', 'native']);
        const action = op.parameters.find((p) => p.name === 'action');
        expect(action.required).to.equal(true);
        expect(action.in).to.equal('query');
        // The pattern must be the one the route enforces, or a client that obeys
        // the spec still gets a 400 INVALID_ACTION.
        expect(new RegExp(action.schema.pattern).test('SEND')).to.equal(true);
        expect(new RegExp(action.schema.pattern).test('send;drop')).to.equal(false);
    });

    it('does not advertise pagination it ignores', function () {
        const refs = op.parameters.map((p) => p.$ref).filter(Boolean);
        expect(refs).to.not.include('#/components/parameters/page');
        expect(refs).to.not.include('#/components/parameters/limit');
        expect(refs).to.not.include('#/components/parameters/sortorder');
    });

    it('returns a verdict object, not a list envelope', function () {
        const schema = op.responses['200'].content['application/json'].schema;
        expect(schema.$ref).to.equal('#/components/schemas/PreflightResponse');
        const verdict = spec.components.schemas.PreflightResponse;
        expect(verdict.type).to.equal('object');
        // `valid` is nullable on purpose: no verdict is a distinct answer from invalid.
        expect(verdict.properties.valid.type).to.deep.equal(['boolean', 'null']);
        for (const field of ['supported', 'guardInert', 'denied', 'feeExempt', 'busy', 'cached', 'status'])
            expect(verdict.properties, field).to.have.property(field);
        // The fee the dry-run already computed is part of the published contract,
        // so a client can disclose it without a second /feequote call.
        expect(verdict.properties).to.have.property('xchainFee');
        expect(verdict.properties.xchainFee.type).to.deep.equal(['string', 'null']);
        // The fee is only judged truthfully if the caller knows which mode it was
        // judged under, and the payer balance is what makes an XCHAIN-mode refusal actionable.
        for (const field of ['feeMode', 'feeTick', 'feeTokenBalance', 'feeAffordable'])
            expect(verdict.properties, field).to.have.property(field);
        expect(verdict.properties.feeTokenBalance.type).to.deep.equal(['string', 'null']);
        expect(verdict.properties.feeAffordable.type).to.deep.equal(['boolean', 'null']);
    });

});

describe('preflight OpenAPI contract', function () {
    const spec = require('../../../../../docs/openapi.json');
    const op = spec.paths['/{COIN}/api/preflight'].get;

    it('declares the status codes the route emits, and only those', function () {
        expect(Object.keys(op.responses).sort()).to.deep.equal(['200', '400', '404', '501', '502']);
    });

    // The published maxLength IS the contract: a client that trusts a stale 8192 will
    // refuse to compose the largest legal batch on the spec's word alone, without ever
    // calling the endpoint. Pinned against the constant the route enforces.
    it('publishes the params ceiling the route actually enforces', function () {
        const params = op.parameters.find((p) => p.name === 'params');
        expect(params.schema.maxLength).to.equal(XChainExplorer.MAX_PREFLIGHT_PARAMS_LENGTH);
        // Documented big enough for the consensus-maximum batch, which is the reason
        // it moved. Guards against a "tidy up the magic number" edit that re-breaks it.
        expect(params.schema.maxLength).to.be.greaterThan(batchParams(250).length);
    });

    it('documents the POST transport with the same fields as a request body', function () {
        const post = spec.paths['/{COIN}/api/preflight'].post;
        expect(post, 'the POST operation must be documented').to.be.an('object');
        const body = post.requestBody.content['application/json'].schema;
        expect(Object.keys(body.properties).sort()).to.deep.equal(['action', 'feeMode', 'params', 'source']);
        expect(body.required).to.deep.equal(['action']);
        expect(body.properties.params.maxLength).to.equal(XChainExplorer.MAX_PREFLIGHT_PARAMS_LENGTH);
        // Same verdict, same schema: two transports, one endpoint.
        expect(post.responses['200'].content['application/json'].schema.$ref)
            .to.equal('#/components/schemas/PreflightResponse');
        // Inherits the GET's failure set and adds only what a body-bearing route can emit.
        expect(Object.keys(post.responses).sort()).to.deep.equal(['200', '400', '404', '413', '429', '501', '502']);
    });

    // The field a batch composer actually reads. It shipped in the response and was
    // never in the published schema, so a generated client dropped it.
    it('documents the per-sub-command verdicts a BATCH answers with', function () {
        const verdict = spec.components.schemas.PreflightResponse;
        expect(verdict.properties).to.have.property('subCommands');
        expect(verdict.properties.subCommands.type).to.equal('array');
        const item = verdict.properties.subCommands.items;
        for (const field of ['position', 'action', 'status', 'refused'])
            expect(item.properties, field).to.have.property(field);
        expect(verdict.properties).to.have.property('oracleFeesOwed');
    });

    // The prose told clients BATCH was refused outright, which stopped being true when
    // the sub-command pre-flight shipped. A client reading the spec would never try.
    it('no longer advertises BATCH as a denied action', function () {
        expect(op.description).to.be.a('string');
        expect(/DEPLOY\/EXECUTE\/XEXEC\/BATCH/.test(op.description),
            'BATCH must not be listed among the flatly denied VM actions').to.equal(false);
        expect(op.description).to.match(/subCommands/);
    });
});

