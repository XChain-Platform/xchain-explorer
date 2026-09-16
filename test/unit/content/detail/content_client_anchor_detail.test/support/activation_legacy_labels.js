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
    // D7: a row mined before ANCHOR_ACTIVATION for its network is legacy
    // regardless of its version byte, because that byte was reused under an
    // older, unrelated meaning before the wire restart. It must render
    // through the SAME known:false path an unrecognized version does, under a
    // dedicated "Legacy (before activation)" label plus its own stored status,
    // and it must NEVER be read against today's v0/v1/v2 traits table - the
    // exact failure mode that motivates the gate (a legacy row misreading as
    // whatever today's version table happens to say that byte means).
    describe('activation gate: rows before ANCHOR_ACTIVATION', function () {
        it('[TRAP] a bundle-shaped row below testnet activation renders as Legacy, never as a v0 bundle', function () {
            const $ = renderPage(LEGACY_TESTNET_BUNDLE);
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.not.contain('bundle');
        });

        it('names the stored reason (the row\'s own status) in the legacy note', function () {
            const $ = renderPage(LEGACY_TESTNET_BUNDLE);
            const note = $('.anchor-field-value .anchor-note').first().text();
            expect(note).to.contain('activation height');
            expect(note).to.contain('Stored status: valid');
        });

        it('surfaces a post-reparse invalid verdict as the stored reason too, and leaves the Status badge untouched', function () {
            const $ = renderPage(Object.assign({}, LEGACY_TESTNET_BUNDLE, {
                status: 'invalid: ANCHOR before activation'
            }));
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-field-value .anchor-note').first().text())
                .to.contain('Stored status: invalid: ANCHOR before activation');
            // The real Status field still shows the raw stored verdict too,
            // unhidden - the legacy note explains it, it does not replace it.
            expect($('.anchor-status-badge').first().text()).to.equal('invalid: ANCHOR before activation');
        });
    });
});
