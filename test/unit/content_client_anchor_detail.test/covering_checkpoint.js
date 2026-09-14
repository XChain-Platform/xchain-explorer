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
    /* ---------------------- covering checkpoint ----------------------- */

    describe('covering checkpoint', function () {

        it('links the covering checkpoint at the CHECKPOINTED height, not the broadcast one', function () {
            const $ = renderPage(V5);
            const href = $('.anchor-covering-link a').attr('href');
            expect(href).to.equal('/RDOGE/checkpoint/2497');
            expect(href, 'the broadcast height would be the wrong lookup key').to.not.contain('2503');
        });

        it('states agreement between the on-chain payload and the mirrored checkpoint', function () {
            const $ = renderPage(V5);
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror agrees with the on-chain payload');
        });

        it('flags a mirror whose block_hash disagrees with the anchor payload', function () {
            const $ = renderPage(Object.assign({}, V5, {
                checkpoint: Object.assign({}, COVERING_CHECKPOINT, { block_hash: '99'.repeat(32) })
            }));
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror DISAGREES with the on-chain payload');
        });

        it('[NULL CHECKPOINT] a missing mirror row names the CHECKPOINTED height it looked up', function () {
            const $ = renderPage(Object.assign({}, V5, { checkpoint: null }));
            const msg = $('#anchor-covering-checkpoint .anchor-empty').text();
            expect(msg).to.contain('checkpointed height 2,497');
            expect(msg).to.contain('not the block the anchor transaction landed in');
            expect(msg, 'the broadcast height must not appear as the lookup key').to.not.contain('2,503');
            expect($('#anchor-covering-checkpoint .text-danger').length, 'an uncovered anchor is not an error').to.equal(0);
        });
    });
});
