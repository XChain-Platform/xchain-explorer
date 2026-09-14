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
 * A MIRROR-APPLIED ATTEST RESPONSE MUST BE LISTED AND MUST BE ANNOUNCED.
 *
 * Above the attest-response-mirror activation height a finalized attestation
 * response is no longer its own on-chain transaction (spec §4.4). The indexer
 * applies it as a system-synthesized ATTEST v1 action: a real action_index and a
 * real block_index, but tx_index NULL and NO `transactions` row anywhere. Two
 * explorer discovery queries used to INNER JOIN `transactions`, which does not
 * degrade such a row, it DELETES it from the result:
 *
 *   - getAttestations(), so the response never appears on /COIN/attestations;
 *   - getActionsSince(), which is worse than a missing list row, because
 *     ChangeDetector calls emitAttestationEvents ONLY for the actions that
 *     query returns. An absent row means ATTESTATION_RESPONSE never fires for
 *     any websocket subscriber, ever, for that response.
 *
 * A query-shape unit test cannot see this: the fault is a JOIN semantic against
 * real rows, so it needs a real database with a real tx-less row in it. This
 * suite builds exactly that fixture (NO transactions row for the response) and
 * drives the shipped queries and the shipped ChangeDetector against it.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 * Skips when the sibling xchain-indexer checkout is absent, like the schema
 * conformance canary next to it, because the DDL under test is the indexer's.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const ChangeDetector = require('../../../src/ws/change_detector.js');
const { makeConfig } = require('../../fixtures/mock-query-args.js');

function registerListingTests(fixture) {
    const { getDb, assertFixtureIsTxLess, BLOCK, BLOCK_TIME, TX_ACTION, MIRROR_ACTION, MIRROR_REQUEST_ID } = fixture;

    it('built a fixture that really has no transactions row', async function () {
        await assertFixtureIsTxLess();
    });

    /******************************************************************
     * 1. getAttestations lists it
     *****************************************************************/

    it('getAttestations returns the tx-less response, with sane values for every tx-derived column', async function () {
        const db = getDb();
        const [rows, total] = await db.getData(makeConfig({ coin: 'RBTC', type: 'api', data: { method: 'getAttestations' } }));
        const indexes = rows.map(r => Number(r.action_index));
        expect(indexes, 'the tx-backed control row vanished, so the rig is wrong, not the query')
            .to.include(TX_ACTION);
        expect(indexes, 'the mirror-applied response is missing from getAttestations')
            .to.include(MIRROR_ACTION);
        expect(Number(total), 'the count query disagrees with the row query').to.equal(2);

        const row = rows.find(r => Number(r.action_index) === MIRROR_ACTION);
        // Placed in its block off the ACTION's own block_index, not through a
        // transaction that does not exist.
        expect(Number(row.block_index)).to.equal(BLOCK);
        expect(Number(row.timestamp)).to.equal(BLOCK_TIME);
        // The transaction-derived columns are NULL, which is what they are. A
        // real null is what the client's isNull/nullToBlank helpers handle; the
        // string 'undefined' or a thrown query are the failures being excluded.
        expect(row.tx_hash, 'tx_hash should be a real null, not a string').to.equal(null);
        expect(row.tx_index, 'tx_index should be a real null, not a string').to.equal(null);
        // Source resolves through the ACTION's source_id (COALESCE's first arm),
        // so it survives the missing transaction.
        expect(row.source).to.equal('bcrt1qattestmirror');
        expect(row.version).to.not.equal(undefined);
        expect(row.request_id).to.equal(MIRROR_REQUEST_ID);
        // Both status fields ride the feed, which is what lets the page show the
        // chain's verdict next to the attester's result instead of instead of it.
        expect(row.response_status).to.equal('ok');
        expect(row.status).to.equal('invalid: REQUEST_ID (no matching request)');
        // Every selected column is either a value or a real null.
        for(const key in row)
            expect(String(row[key])).to.not.equal('undefined', 'column ' + key + ' came back undefined');
    });

    it('serves the tx-less response on the block-filtered lane too', async function () {
        const db = getDb();
        // The block lane binds `b1.block_index=?`, so it is the lane that proves
        // b1 now hangs off the action rather than off a transaction row.
        const [rows] = await db.getData(makeConfig({
            coin: 'RBTC', type: 'api',
            data: { method: 'getAttestations', type: 'block', search: BLOCK }
        }));
        expect(rows.map(r => Number(r.action_index)),
            'the block lane resolves b1 through the transaction, so the mirror row is filtered out')
            .to.include(MIRROR_ACTION);
    });
}

function registerActionTests(fixture) {
    const { getDb, BLOCK, TX_ACTION, MIRROR_ACTION } = fixture;

    /******************************************************************
     * 2. getActionsSince returns it, so the detector can see it at all
     *****************************************************************/

    it('getActionsSince returns the tx-less action', async function () {
        const db = getDb();
        const rows = await db.getActionsSince({ coin: 'RBTC' }, 0, 100);
        const indexes = rows.map(r => Number(r.action_index));
        expect(indexes).to.include(TX_ACTION);
        expect(indexes, 'the tx-less action is invisible to the WS discovery feed')
            .to.include(MIRROR_ACTION);
        const row = rows.find(r => Number(r.action_index) === MIRROR_ACTION);
        expect(row.action).to.equal('ATTEST');
        expect(Number(row.block_index)).to.equal(BLOCK);
        expect(row.tx_hash, 'tx_hash should be a real null on a synthesized action').to.equal(null);
        expect(row.source).to.equal('bcrt1qattestmirror');
        expect(row.destinations, 'the destinations enrichment did not run').to.be.an('array');
    });
}

function registerSocketTests(fixture) {
    const { getDb, BLOCK, TX_ACTION, MIRROR_ACTION, MIRROR_REQUEST_ID } = fixture;

    /******************************************************************
     * 3. THE ASSERTION THAT MATTERS: the event actually fires
     *****************************************************************/

    it('fires ATTESTATION_RESPONSE on the websocket for the tx-less response', async function () {
        const db = getDb();
        // A detector seeded BELOW both actions, so one poll drains the block.
        const detector = new ChangeDetector({ db, pollInterval: 3600000, fetchLimit: 100 });
        const lifecycle = [];
        const actions   = [];
        detector.on('lifecycle_event', (coin, e) => lifecycle.push(e));
        detector.on('action', (coin, a) => actions.push(a));
        detector.state = { RBTC: { blockIndex: BLOCK - 1, actionIndex: TX_ACTION - 1,
                                   closedBlock: BLOCK - 1, xcallBlock: BLOCK - 1, initialized: true } };
        detector.mempoolState = { RBTC: { seenHashes: new Map(), initialized: true } };

        await detector.checkCoin('RBTC');

        const responses = lifecycle.filter(e => e.type === 'ATTESTATION_RESPONSE');
        const announced = responses.map(e => Number(e.data.action_index));
        expect(announced, 'ATTESTATION_RESPONSE never fired for the mirror-applied response')
            .to.include(MIRROR_ACTION);
        // The control proves the channel works at all, so a green above is about
        // the tx-less row and not about the detector being wired up.
        expect(announced, 'the tx-backed control response was not announced either; the rig is wrong')
            .to.include(TX_ACTION);

        const frame = responses.find(e => Number(e.data.action_index) === MIRROR_ACTION);
        expect(frame.channel).to.equal('attestation');
        expect(frame.action).to.equal('ATTEST');
        expect(Number(frame.data.version)).to.equal(1);
        expect(frame.data.request_id).to.equal(MIRROR_REQUEST_ID);
        expect(Number(frame.data.block_index)).to.equal(BLOCK);
        // The enrichment read (getAttestationByActionIndex) was already tx-less
        // safe; what was missing was ever reaching it.
        expect(frame.data.response_status).to.equal('ok');
        expect(actions.map(a => Number(a.action_index)),
            'the generic NEW_ACTION feed skipped the tx-less action').to.include(MIRROR_ACTION);
    });
}

function registerBatchDetailTests(fixture) {
    const { getDb, adminQuery, MIRROR_ACTION, MIRROR_REQUEST_ID, INDEXER_DB } = fixture;

    /******************************************************************
     * 4. The batch link is carried on the detail read
     *****************************************************************/

    it('getAttestation carries batch_action_index for a mirror-applied response', async function () {
        const db = getDb();
        // A composed read. getQuery destructures the method's return, so the
        // composition's single entry lands in getData's `query` slot and comes
        // back as the data itself, not wrapped in a row array.
        const [detail] = await db.getData(makeConfig({
            coin: 'RBTC', type: 'api', data: { method: 'getAttestation', search: MIRROR_REQUEST_ID }
        }));
        expect(detail, 'the attestation detail read returned nothing for the mirror row').to.not.equal(null);
        expect(detail.response, 'no v1 leg on the composed detail').to.not.equal(undefined);
        // NULL while the ATTEST v5/v6 batch carrying the body has not landed.
        // The column has to be SELECTED for the page to tell that apart from
        // "this response was its own transaction", which is a different fact.
        expect(detail.response).to.have.property('batch_action_index');
        expect(detail.response.batch_action_index).to.equal(null);
        expect(detail.response.tx_index, 'the mirror leg should carry a null tx_index').to.equal(null);

        await adminQuery('UPDATE `' + INDEXER_DB + '`.attests SET batch_action_index=? WHERE action_index=?',
            [990, MIRROR_ACTION]);
        const [linked] = await db.getData(makeConfig({
            coin: 'RBTC', type: 'api', data: { method: 'getAttestation', search: MIRROR_REQUEST_ID }
        }));
        expect(Number(linked.response.batch_action_index),
            'the batch link does not follow the stored column').to.equal(990);
        await adminQuery('UPDATE `' + INDEXER_DB + '`.attests SET batch_action_index=NULL WHERE action_index=?',
            [MIRROR_ACTION]);
    });
}

function registerTimestampTests(fixture) {
    const { getDb, BLOCK_TIME, MIRROR_REQUEST_ID, TX_REQUEST_ID } = fixture;

    /******************************************************************
     * 5. The detail page's own timestamp resolves off the action, not the
     *    transaction that a mirror-applied response never has.
     *****************************************************************/

    it('getAttestation resolves a timestamp for a mirror-applied response with no transaction row', async function () {
        const db = getDb();
        const [detail] = await db.getData(makeConfig({
            coin: 'RBTC', type: 'api', data: { method: 'getAttestation', search: MIRROR_REQUEST_ID }
        }));
        expect(detail, 'the attestation detail read returned nothing for the mirror row').to.not.equal(null);
        expect(detail.response, 'no v1 leg on the composed detail').to.not.equal(undefined);
        expect(Number(detail.response.timestamp),
            'the block join fell through, so the detail page has no timestamp for this response')
            .to.equal(BLOCK_TIME);
        expect(detail.response.tx_hash, 'tx_hash should be a real null on a synthesized action').to.equal(null);

        // The tx-backed control in the same fixture must be unaffected: it is what
        // proves this fixture discriminates rather than passing by coincidence.
        const [control] = await db.getData(makeConfig({
            coin: 'RBTC', type: 'api', data: { method: 'getAttestation', search: TX_REQUEST_ID }
        }));
        expect(control.response, 'no v1 leg on the tx-backed control').to.not.equal(undefined);
        expect(Number(control.response.timestamp), 'the tx-backed control changed behavior').to.equal(BLOCK_TIME);
    });
}

module.exports = {
    registerListingTests,
    registerActionTests,
    registerSocketTests,
    registerBatchDetailTests,
    registerTimestampTests
};
