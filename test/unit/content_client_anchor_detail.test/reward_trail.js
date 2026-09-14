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

const { expect, renderPage, domWithPage, loadPage, V5, V1, BUNDLE, BUNDLE_SECTIONS, PUBLISHER, TXID_V5, TXID_V1, COVERING_CHECKPOINT, LEGACY_TESTNET_BUNDLE } = require('../content_client_anchor_detail.test.js');

describe('anchor.html detail render @regression', function () {
    /* --------------------- reward attestation trail -------------------- */

    describe('reward attestation trail', function () {

        it('renders the reward row with its exact stored columns', function () {
            const $ = renderPage(V5);
            const row = $('.anchor-reward-row');
            expect(row.length).to.equal(1);
            expect(row.find('.anchor-reward-id').text()).to.equal('1');
            expect(row.find('.anchor-reward-type').text()).to.equal('anchor_DOGE');
            expect(row.find('.anchor-reward-round').text()).to.equal('110');
            expect(row.find('.anchor-reward-amount').text()).to.equal('10.00000000');
            expect(row.find('.anchor-reward-txid').text()).to.equal(TXID_V5);
            expect($('.anchor-reward-scope').text()).to.contain('DOGE/regtest');
        });

        it('renders the archive-reward row on the v6 anchor', function () {
            const $ = renderPage(V1);
            expect($('.anchor-reward-row .anchor-reward-type').text()).to.equal('anchor_archive');
            expect($('.anchor-reward-row .anchor-reward-round').text()).to.equal('7');
        });

        it('[LINKAGE] separates a txid-PROVEN reward from one matched only by round', function () {
            // getAnchor ORs the two correlations, so both shapes reach the page.
            // Rendering the weaker one as proof would overstate the evidence.
            const $ = renderPage(Object.assign({}, V5, {
                reward_attestations: [
                    Object.assign({}, V5.reward_attestations[0], { id: 1, doge_anchor_txid: TXID_V5 }),
                    Object.assign({}, V5.reward_attestations[0], { id: 3, doge_anchor_txid: TXID_V1 })
                ]
            }));
            const badges = $('.anchor-reward-linkage').map(function (i, el) { return $(el).text(); }).get();
            expect(badges).to.deep.equal(['proven by txid', 'matched by round']);
            expect($('.anchor-reward-linkage.text-bg-success').length, 'only the txid match is proof').to.equal(1);
        });

        it('[EMPTY TRAIL] an anchor with no rewards renders an absence, never an error', function () {
            const $ = renderPage(Object.assign({}, V5, { reward_attestations: [] }));
            const panel = $('#anchor-rewards');
            expect(panel.find('.anchor-empty').text()).to.contain('No reward attestation is recorded');
            expect(panel.find('.text-danger').length, 'an unrewarded anchor is not a failure').to.equal(0);
            expect(panel.find('.alert-danger, .alert-warning').length).to.equal(0);
            expect(panel.find('.anchor-reward-row').length).to.equal(0);
            // The rest of the page must still be fully rendered.
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
        });

        it('a missing reward_attestations key is treated as an empty trail, not a crash', function () {
            const bare = Object.assign({}, V5);
            delete bare.reward_attestations;
            const $ = renderPage(bare);
            expect($('#anchor-rewards .anchor-empty').length).to.equal(1);
        });
    });
});
