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
    describe('version traits', function () {
        it('renders a v1 as the ARCHIVE HEAD: archive card revealed with batch + chunk trail', function () {
            const $ = renderPage(V1);
            expect($('.anchor-version-badge').text()).to.equal('v1');
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v1 carries an archive').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
            expect($('#anchor-archive-payload .anchor-chunk-row').length).to.equal(2);
            expect($('#anchor-archive-payload .anchor-chunk-self').length, 'this anchor is marked inside its own batch').to.equal(1);
            // A v1 still carries a checkpoint, so the checkpoint payload stays.
            expect($('#anchor-checkpoint-payload .anchor-empty').length).to.equal(0);
        });

        it('a v1 with null roots shows no root rows rather than empty root rows', function () {
            const $ = renderPage(V1);
            expect($('.anchor-state-root-row').length).to.equal(0);
        });

        it('a v2 continuation chunk says it carries no checkpoint instead of showing blanks', function () {
            const $ = renderPage(Object.assign({}, V1, {
                version: 2, checkpoint_seq: null, chunk_index: 1, publisher: null,
                publisher_attestations: []
            }));
            expect($('.anchor-kind').text()).to.equal('Archive continuation chunk');
            expect($('#anchor-checkpoint-payload .anchor-empty').text())
                .to.contain('carries no checkpoint payload');
        });

        it('falls back to the row shape for an unrecognized version instead of rendering nothing', function () {
            const $ = renderPage(Object.assign({}, V1, { version: 9 }));
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v9');
            expect($('#anchor-archive-card').hasClass('d-none'), 'match_batch_seq is set, so the archive still renders').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
        });
    });
});
