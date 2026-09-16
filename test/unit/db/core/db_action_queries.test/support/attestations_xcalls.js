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
 * Unit tests for all get* ACTION query methods in src/db/index.js
 *
 * Each method is called directly (no DB connection needed) and the returned
 * [query, args, count] triple is verified for:
 *   - correct array length (3 elements)
 *   - presence of the expected main table name in both query and count
 *   - presence of sql.where.data in the WHERE clause
 *   - ORDER BY and LIMIT clauses driven by sql.order / sql.limit
 *   - args value (null for most methods, an array for those that build args internally)
 */

'use strict';

const { expect, makeConfig, db, WHERE_DATA, SEARCH_ADDR, makeActionConfig } = require('./helpers.js');

// The attests table stores the full attestation request body in `payload`
// (oracle URL for http_get providers, JSON prompt envelope for llm providers)
// and the developer-supplied callback params in `callback_params_json`. Both
// must be present in every attests-reading query so API/WebSocket consumers
// can inspect what an attestation asked for; a regression that drops either
// column from a SELECT silently hides the request body from consumers.

describe('Database#getAttestations exposes payload and callback_params_json', () => {
    it('list query and count select both columns from the attests table', async () => {
        const config = makeActionConfig('getAttestations', 'address');
        const [query, args, count] = await db.getAttestations(config);
        expect(query).to.be.a('string');
        expect(query).to.include('attests m');
        expect(query).to.include('m.payload');
        expect(query).to.include('m.callback_params_json');
        // fee_payer (the gas-billing address) is resolved from fee_payer_id,
        // NOT from source_id (which holds the request-emitting contract address).
        expect(query).to.include('fp.address as fee_payer');
        expect(query).to.include('fp.id=m.fee_payer_id');
        // List + count return the standard [query, null, count] triple.
        expect(args).to.be.null;
        expect(count).to.include('attests m');
    });

    it('list query exposes response_payload (the provider response body)', async () => {
        const config = makeActionConfig('getAttestations', 'address');
        const [query] = await db.getAttestations(config);
        expect(query).to.include('m.response_payload');
    });
});

describe('Database#getAttestationsSince / getAttestationByActionIndex expose payload and callback_params_json', () => {
    let captured;
    let originalDoQuery;

    before(() => {
        originalDoQuery = db.doQuery;
        // Capture the generated SQL without needing a live DB connection.
        db.doQuery = async (config, query) => { captured.push(query); return []; };
    });

    after(() => {
        db.doQuery = originalDoQuery;
    });

    beforeEach(() => { captured = []; });

    it('getAttestationsSince (WebSocket feed) selects both columns', async () => {
        const config = makeActionConfig('getAttestationsSince');
        await db.getAttestationsSince(config, 0, 100);
        expect(captured).to.have.lengthOf(1);
        expect(captured[0]).to.include('attests m');
        expect(captured[0]).to.include('m.payload');
        expect(captured[0]).to.include('m.callback_params_json');
        expect(captured[0]).to.include('fp.address as fee_payer');
        expect(captured[0]).to.include('fp.id=m.fee_payer_id');
    });

    it('getAttestationByActionIndex (single lookup) selects both columns', async () => {
        const config = makeActionConfig('getAttestationByActionIndex');
        await db.getAttestationByActionIndex(config, 1);
        expect(captured).to.have.lengthOf(1);
        expect(captured[0]).to.include('FROM attests');
        expect(captured[0]).to.include('payload');
        expect(captured[0]).to.include('callback_params_json');
        expect(captured[0]).to.include('fp.address as fee_payer');
        expect(captured[0]).to.include('fp.id=m.fee_payer_id');
    });
});

// XCALL is a cross-chain contract call: getXcalls lists them, getXcall below
// follows one call through its lifecycle.
describe('Database#getXcalls', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getXcalls', 'contract');
        result = await db.getXcalls(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads xcalls and joins the actions/transactions/blocks chain', () => {
        const [query] = result;
        expect(query).to.include('xcalls m');
        expect(query).to.include('JOIN actions');
        expect(query).to.include('JOIN transactions');
        expect(query).to.include('JOIN blocks');
        expect(query).to.include('m.call_id');
        expect(query).to.include('m.request_status');
    });

    it('count uses same WHERE, args is null, ORDER BY + LIMIT applied', () => {
        const [query, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
        expect(query).to.include('ORDER BY m.action_index DESC');
        expect(query).to.include('LIMIT 100');
    });
});

// One XCALL by call_id, read together with its execution and callback records.
describe('Database#getXcall', () => {
    let captured, originalDoQuery;

    before(() => {
        originalDoQuery = db.doQuery;
        // Return a row with a call_id so the execution + callback follow-up queries run.
        db.doQuery = async (config, query) => {
            captured.push(query);
            return [{ call_id: 'abc', params_json: null, callback_params_json: null }];
        };
    });
    after(() => { db.doQuery = originalDoQuery; });
    beforeEach(() => { captured = []; });

    it('queries xcalls, then the execution + callback lifecycle tables by call_id', async () => {
        const config = makeActionConfig('getXcall', 'call_id');
        const result = await db.getXcall(config);
        expect(result).to.be.an('array').with.lengthOf(1);
        expect(captured).to.have.lengthOf(3);
        expect(captured[0]).to.include('xcalls m');
        expect(captured[1]).to.include('cross_chain_call_executions');
        expect(captured[2]).to.include('cross_chain_call_callbacks');
    });

    it('pins the lifecycle read to the VALID row, matching the indexer authority', async () => {
        // call_id is not unique in xcalls (rejected attempts index alongside the
        // accepted request), so the single-row read must carry the status bound
        // or the ORDER BY can surface an invalid row as the lifecycle.
        const config = makeActionConfig('getXcall', 'call_id');
        await db.getXcall(config);
        expect(captured[0]).to.include("s1.status='valid'");
        expect(captured[0]).to.include('m.call_id');
    });

    it('attaches execution + callback_delivery sub-objects to the returned row', async () => {
        const config = makeActionConfig('getXcall', 'call_id');
        const [data] = await db.getXcall(config);
        expect(data).to.be.an('object');
        expect(data).to.have.property('execution');
        expect(data).to.have.property('callback_delivery');
    });
});
