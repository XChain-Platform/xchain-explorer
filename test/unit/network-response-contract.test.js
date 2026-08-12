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
 * Contract test: GET /{COIN}/api/network against its published schema.
 *
 * This operation used to answer the shared, property-less ObjectResponse, so
 * every field of it was unconstrained: the xchain-dashboard monitor reads
 * network.block to gate its checkpoint-stall alert, and a rename or a null
 * there would still have validated against the published contract while
 * silently stopping that alert from firing.
 *
 * The producer is driven for real here (db.getNetwork with only its DB reads
 * stubbed), so the assertion is about the SHIPPED response, not a fixture. A
 * fixture would pass forever after a rename; this fails.
 *
 * The validator is written out rather than pulled from a schema library: the
 * only JSON-schema implementation in the tree is a transitive dependency, and a
 * contract test that can disappear on someone else's dependency bump is not a
 * contract test. It covers exactly the keywords NetworkResponse uses.
 *********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openapi.json'), 'utf8'));

function deref(node) {
    if (node && node.$ref) {
        const name = node.$ref.replace('#/components/schemas/', '');
        return SPEC.components.schemas[name];
    }
    return node;
}

// Returns a list of violation strings; empty means the value satisfies the schema.
function validate(schema, value, at) {
    schema = deref(schema);
    at = at || '$';
    const errs = [];
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some((t) => {
        if (t === undefined) return true;
        if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
        if (t === 'number')  return typeof value === 'number';
        return t === actual;
    });
    if (!ok) {
        errs.push(at + ': expected ' + types.join('|') + ', got ' + actual);
        return errs;   // a wrong type makes the children meaningless
    }
    if (actual !== 'object') return errs;

    for (const key of schema.required || [])
        if (!Object.prototype.hasOwnProperty.call(value, key))
            errs.push(at + ': missing required property "' + key + '"');

    for (const [key, sub] of Object.entries(schema.properties || {}))
        if (Object.prototype.hasOwnProperty.call(value, key))
            errs.push(...validate(sub, value[key], at + '.' + key));

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        for (const [key, v] of Object.entries(value))
            if (!(schema.properties || {})[key])
                errs.push(...validate(schema.additionalProperties, v, at + '.' + key));

    return errs;
}

function networkSchema() {
    const op = SPEC.paths['/{COIN}/api/network'];
    expect(op, 'the spec no longer documents /{COIN}/api/network').to.not.equal(undefined);
    return op.get.responses['200'].content['application/json'].schema;
}

// The real producer with only its DB / network reads stubbed. Everything the
// schema describes is built by the shipped getNetwork(), including the coin
// identity and the finality map, which come from config and the coin registry.
async function producedNetworkBody() {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });

    sinon.stub(db, 'getMaxBlockIndex').resolves(880123);
    sinon.stub(db, 'getMaxBlockTime').resolves(1743638400);
    sinon.stub(db, 'getDecoderMempoolCount').resolves(7);
    sinon.stub(db, 'getFeeEstimate').resolves({ low: 1, medium: 2, high: 3 });
    sinon.stub(db, 'getCoinPriceUsd').resolves('64000.00');
    sinon.stub(db, 'getActionTotals').resolves({ sends: 10, tokens: 2 });

    const [body] = await db.getNetwork(makeConfig({ coin: 'BTC' }));
    // The route sink stamps runtime onto every JSON response before sending
    // (XChainExplorer.processRequest), so the wire body carries it too.
    body.runtime = '12ms';
    return body;
}

describe('/{COIN}/api/network response contract', function () {

    afterEach(() => sinon.restore());

    it('the operation is typed, not left on the property-less ObjectResponse', function () {
        const schema = networkSchema();
        expect(schema.$ref).to.equal('#/components/schemas/NetworkResponse');
        expect(deref(schema).properties).to.be.an('object');
    });

    it('the schema constrains the fields the dashboard monitor actually reads', function () {
        // xchain-dashboard/monitor: protocol.js reads data.network + data.totals,
        // and alerts/evaluator.js reads data.network.block for the checkpoint-stall
        // gate. Loosening any of these back to optional silently breaks that alert.
        const s = deref(networkSchema());
        expect(s.required).to.include.members(['network', 'totals']);
        expect(deref(s.properties.network).required).to.include('block');
        expect(deref(s.properties.network).properties.block.type).to.equal('integer');
    });

    it('the shipped producer output validates against the published schema', async function () {
        const errs = validate(networkSchema(), await producedNetworkBody());
        expect(errs, errs.join('; ')).to.deep.equal([]);
    });

    it('a renamed network.block fails the contract instead of passing silently', async function () {
        const body = await producedNetworkBody();
        body.network.net_block = body.network.block;
        delete body.network.block;
        const errs = validate(networkSchema(), body);
        expect(errs.join('; ')).to.include('missing required property "block"');
    });

    it('a nulled network.block fails the contract', async function () {
        const body = await producedNetworkBody();
        body.network.block = null;
        const errs = validate(networkSchema(), body);
        expect(errs.join('; ')).to.include('$.network.block');
    });

});
