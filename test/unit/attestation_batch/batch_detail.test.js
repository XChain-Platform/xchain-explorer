/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const {
    expect, renderDom, paint, loadPage, responseLeg
} = require('../content/detail/content_client_attestation_detail.test/support/helpers.js');

const BATCH_KEY = 'a'.repeat(64);
const REQUEST_A = 'b'.repeat(64);
const REQUEST_B = 'c'.repeat(64);

function batch(){
    return {
        batch: {
            action_index: 500,
            version: 5,
            batch_key: BATCH_KEY,
            request_id: BATCH_KEY,
            batch_window_start: Date.UTC(2026, 9, 2, 10, 0) / 1000,
            batch_window_end: Date.UTC(2026, 9, 2, 11, 0) / 1000,
            batch_row_count: 2,
            source: 'publisher-a',
            status: 'valid'
        },
        continuations: [{
            action_index: 501,
            version: 6,
            batch_chunk_index: 1,
            batch_total_chunks: 2
        }],
        responses: [{
            action_index: 300,
            request_id: REQUEST_A,
            request_action_index: 200,
            response_status: 'ok'
        }, {
            action_index: 301,
            request_id: REQUEST_B,
            request_action_index: 201,
            response_status: 'timeout'
        }],
        duplicates: [{
            action_index: 510,
            source: 'publisher-b',
            block_index: 52,
            tx_hash: 'd'.repeat(64)
        }]
    };
}

describe('ATTEST batch detail card', function(){
    it('renders the window, response count, publisher, chunks, responses and duplicates', function(){
        const dom = renderDom();
        const $ = paint(dom, dom.window.renderAttestationBatch(batch()));
        expect($('#out').text()).to.contain('Batch key');
        expect($('#out').text()).to.contain('2026-10-02 10:00 UTC to 2026-10-02 11:00 UTC');
        expect($('.attestation-batch-response-count').text()).to.equal('2');
        expect($('#out').text()).to.contain('publisher-a');
        expect($('.attestation-batch-continuation').text()).to.contain('chunk 2 of 2');
        expect($('.attestation-batch-response').length).to.equal(2);
        expect($('.attestation-batch-response a[href="/RBTC/attestation/' + REQUEST_A + '"]').length).to.equal(1);
        expect($('.attestation-batch-response a[href="/RBTC/attestation/' + REQUEST_B + '"]').length).to.equal(1);
        expect($('.attestation-batch-duplicate').length).to.equal(1);
        expect($('.attestation-batch-duplicate').text()).to.contain('publisher-b');
    });

    it('links carried BTC lifecycle rows from a DOGE batch page to the network BTC explorer', function(){
        const dom = renderDom();
        dom.window.eval("XC.coin = 'RDOGE'");
        const payload = batch();
        payload.responses.forEach(row => { row.coin = 'RBTC'; });
        const $ = paint(dom, dom.window.renderAttestationBatch(payload));

        expect($('.attestation-batch-response a[href="/RBTC/attestation/' + REQUEST_A + '"]').length).to.equal(1);
        expect($('.attestation-batch-response a[href="/RBTC/action/200"]').length).to.equal(1);
        expect($('.attestation-batch-response a[href^="/RDOGE/"]').length).to.equal(0);
    });

    it('switches the shipped detail page from request lifecycle cards to the batch card', function(){
        const payload = batch();
        const url = '/RBTC/api/attestation/' + BATCH_KEY;
        const page = loadPage({ [url]: payload }, BATCH_KEY);
        expect(page.seen).to.deep.equal([url]);
        expect(page.$('#attestation-key-label').text()).to.equal('Batch key');
        expect(page.$('#attestation-party-label').text()).to.equal('Publisher');
        expect(page.$('#attestation-batch-key-value').text()).to.equal(BATCH_KEY);
        expect(page.$('#attestation-batch-card').hasClass('d-none')).to.equal(false);
        expect(page.$('.attestation-lifecycle-card:not(.d-none)').length).to.equal(0);
        expect(page.$('#attestation-batch .attestation-batch-response').length).to.equal(2);
    });

    it('labels a carried response as archived in its batch', function(){
        const dom = renderDom();
        const data = { response: responseLeg({ batch_action_index: 500 }) };
        const $ = paint(dom, dom.window.renderAttestationResponse(data));
        expect($('#out').text()).to.contain('Archived in batch');
        expect($('a[href="/RDOGE/action/500"]').length).to.equal(1);
    });
});
