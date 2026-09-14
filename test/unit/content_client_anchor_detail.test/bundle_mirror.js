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
    describe('v0 bundle sections', function () {
        it('[TRAP] cross-checks the mirror against THIS coin\'s section, not the header chain', function () {
            const $ = renderPage(BUNDLE);
            // The header carries BTC's hash and the mirror holds DOGE's. Comparing
            // those two would report a false disagreement on a healthy bundle.
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror agrees with the on-chain payload');
            expect($('.anchor-covering-link a').attr('href')).to.equal('/RDOGE/checkpoint/3001');
        });

        it('names the missing mirror by THIS coin\'s section height', function () {
            const $ = renderPage(Object.assign({}, BUNDLE, { checkpoint: null }));
            const msg = $('#anchor-covering-checkpoint .anchor-empty').text();
            expect(msg).to.contain('checkpointed height 3,001');
            expect(msg, 'another section\'s height was never looked up').to.not.contain('2,497');
        });

        it('renders the single anchor_bundle reward as the round-keyed trail it is', function () {
            const $ = renderPage(BUNDLE);
            expect($('.anchor-reward-row').length).to.equal(1);
            expect($('.anchor-reward-type').text()).to.equal('anchor_bundle');
            expect($('.anchor-reward-linkage').text()).to.equal('proven by txid');
        });

        it('a one-section bundle renders as a normal cycle, not as a fault', function () {
            const $ = renderPage(Object.assign({}, BUNDLE, {
                sections: [BUNDLE_SECTIONS[1]], section_count: 1, local_section_index: 1
            }));
            expect($('.anchor-section-row').length).to.equal(1);
            expect($('.anchor-section-count').text()).to.equal('1');
            expect($('#anchor-sections .text-danger').length, 'a short bundle is the normal daily case').to.equal(0);
            expect($('#anchor-sections-card').hasClass('d-none')).to.equal(false);
        });
    });
});
