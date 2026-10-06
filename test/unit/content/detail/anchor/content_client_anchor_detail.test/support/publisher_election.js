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
 */

'use strict';

const { expect, renderPage, domWithPage, loadPage, V5, V1, BUNDLE, BUNDLE_SECTIONS, PUBLISHER, TXID_V5, TXID_V1, COVERING_CHECKPOINT, LEGACY_TESTNET_BUNDLE } = require('../../content_client_anchor_detail.test.js');

describe('anchor.html detail render @regression', function () {
    /* ------------------------ publisher election ---------------------- */

    describe('publisher election', function () {

        it('renders the electorate and marks which member the anchor elected', function () {
            const $ = renderPage(V5);
            expect($('.anchor-elector-row').length).to.equal(2);
            const elected = $('.anchor-elector-elected');
            expect(elected.length, 'exactly one member is the elected publisher').to.equal(1);
            expect(elected.text()).to.contain(PUBLISHER);
            expect($('.anchor-publisher').text()).to.equal(PUBLISHER);
        });

        it('names the wire attestation tail as unverified transport, not a quorum', function () {
            const $ = renderPage(V5);
            expect($('.anchor-tail-count').text()).to.equal('2');
            expect($('.anchor-tail-row .anchor-note').text()).to.contain('not a verified quorum');
        });

        it('an empty electorate renders as an absence, with no error styling', function () {
            const $ = renderPage(Object.assign({}, V5, { publisher_election: [] }));
            expect($('#anchor-election .anchor-empty').text()).to.contain('No oracle_publish electorate');
            expect($('#anchor-election .text-danger').length).to.equal(0);
        });
    });
});
