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
    /* ---------------------- the two block heights ---------------------- */

    describe('the two block heights', function () {

        it('[TRAP] labels the CHECKPOINTED height and the ANCHOR TRANSACTION height distinctly', function () {
            const $ = renderPage(V5);
            const cp = $('.anchor-height-checkpointed');
            const bc = $('.anchor-height-broadcast');
            expect(cp.length, 'the checkpointed-height row renders').to.equal(1);
            expect(bc.length, 'the broadcast-height row renders').to.equal(1);

            // The label-to-value binding is the whole point: swapping the two
            // labels must fail here, not ship.
            expect(cp.find('.anchor-height-label').text()).to.equal('Checkpointed Block');
            expect(cp.find('.anchor-height-value').text()).to.equal('2,497');
            expect(bc.find('.anchor-height-label').text()).to.equal('Anchor Transaction Block');
            expect(bc.find('.anchor-height-value').text()).to.equal('2,503');
        });

        it('[TRAP] never renders either height under a bare "Block" label', function () {
            const $ = renderPage(V5);
            const labels = $('.anchor-height-label').map(function (i, el) { return $(el).text(); }).get();
            expect(labels).to.have.lengthOf(2);
            for (const l of labels)
                expect(l, 'an unqualified "Block" label is the misreading this page exists to prevent').to.not.equal('Block');
        });

        it('[TRAP] each height carries its own explanation of which one it is', function () {
            const $ = renderPage(V5);
            expect($('.anchor-height-checkpointed .anchor-note').text())
                .to.contain('Checkpoint and commitment lookups key off THIS height');
            expect($('.anchor-height-broadcast .anchor-note').text())
                .to.contain('ANCHOR transaction itself was mined in');
        });

        it('keeps the two heights apart on the v6 archive anchor too (2497 vs 2505)', function () {
            const $ = renderPage(V1);
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('2,505');
        });

        it('shows a missing broadcast height as absent rather than borrowing the checkpointed one', function () {
            const $ = renderPage(Object.assign({}, V5, { block_index_doge: null }));
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('-');
        });
    });
});
