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
    /* --------------------------- v0 bundle ---------------------------- */

    describe('v0 bundle sections', function () {
        it('renders ONE row per chain, in section_index order, with each chain\'s own payload', function () {
            const $ = renderPage(BUNDLE);
            const rows = $('.anchor-section-row');
            expect(rows.length, 'three chains rode this anchor').to.equal(3);
            expect(rows.find('.anchor-section-index').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['0', '1', '2']);
            expect(rows.find('.anchor-section-chain').map(function (i, el) { return $(el).text().trim().split(' ')[0]; }).get())
                .to.deep.equal(['BTC', 'DOGE', 'LTC']);
            // Each section commits its OWN height and sequence; collapsing them onto
            // the header's would show one chain's checkpoint three times.
            expect(rows.find('.anchor-section-block').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['2,497', '3,001', '1,200']);
            expect(rows.find('.anchor-section-seq').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['110', '112', '111']);
            expect(rows.find('.anchor-section-sig-count').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['1', '2', '0']);
        });

        it('reveals the sections card on a bundle and hides it on a single-checkpoint anchor', function () {
            expect(renderPage(BUNDLE)('#anchor-sections-card').hasClass('d-none')).to.equal(false);
            expect(renderPage(V5)('#anchor-sections-card').hasClass('d-none'), 'a v5 carries no sections').to.equal(true);
            expect(renderPage(BUNDLE)('#anchor-archive-card').hasClass('d-none'), 'a bundle carries no archive').to.equal(true);
        });

        it('[TRAP] marks THIS explorer\'s own section rather than treating section 0 as the anchor', function () {
            const $ = renderPage(BUNDLE);
            const local = $('.anchor-section-local');
            expect(local.length, 'exactly one section belongs to this coin').to.equal(1);
            expect(local.find('.anchor-section-chain').text()).to.contain('DOGE');
            expect(local.find('.anchor-section-block').text()).to.equal('3,001');
        });
    });
});
