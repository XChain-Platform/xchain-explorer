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
    describe('v0 bundle sections', function () {
        it('[TRAP] the checkpoint card carries only what the BUNDLE owns, never section 0\'s hashes', function () {
            const $ = renderPage(BUNDLE);
            const card = $('#anchor-checkpoint-payload');
            expect(card.find('.anchor-section-count').text()).to.equal('3');
            // Section 0's block hash rendered here would read as the whole anchor's.
            expect(card.text(), 'a per-chain hash must not stand in for the bundle')
                .to.not.contain('b7b7b7');
            expect(card.find('.anchor-snapshot-block').text()).to.contain('112');
        });

        it('[TRAP] lists a checkpointed height PER CHAIN instead of one height for the bundle', function () {
            const $ = renderPage(BUNDLE);
            const labels = $('.anchor-height-label').map(function (i, el) { return $(el).text(); }).get();
            expect(labels).to.deep.equal(['Checkpointed Blocks', 'Anchor Transaction Block']);
            for (const l of labels) expect(l).to.not.equal('Block');
            const heights = $('.anchor-height-checkpointed .anchor-section-height').map(function (i, el) { return $(el).text(); }).get();
            expect(heights).to.deep.equal(['BTC 2,497', 'DOGE 3,001', 'LTC 1,200']);
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('3,010');
        });

        it('names every chain in the bundle instead of one chain for the action', function () {
            const $ = renderPage(BUNDLE);
            expect($('.anchor-bundle-chains').text()).to.equal('BTC, DOGE, LTC');
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.contain('bundle');
        });
    });
});
