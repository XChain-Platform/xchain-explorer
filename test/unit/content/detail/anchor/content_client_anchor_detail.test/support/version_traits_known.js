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
    /* ------------------------- version traits ------------------------- */

    describe('version traits', function () {
        // v5 has no v0/v1/v2 equivalent after the restart (roots + tail,
        // no bundle, no archive), and this row's own network (regtest) has no
        // activation history, so it falls to the unrecognized-version shape
        // fallback rather than the legacy-before-activation path (that path is
        // covered separately below). Its PAYLOAD still renders in full: only the
        // label and the "known" flag change, because the fallback derives every
        // leg from the row's own columns.
        it('a retired non-bundle root-bearing version (v5) is no longer a known trait, but its payload still renders', function () {
            const $ = renderPage(V5);
            expect($('.anchor-version-badge').text()).to.equal('v5');
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v5');
            expect($('.anchor-state-root-row').length, 'a v5 carries state_root').to.equal(1);
            expect($('.anchor-block-merkle-row').length, 'a v5 carries block_merkle_root').to.equal(1);
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v5 carries no archive').to.equal(true);
            expect($('#anchor-checkpoint-payload .anchor-sig-count').text()).to.equal('1');
        });

        it('renders a v0 bundle-family checkpoint: known trait, no activation note, no "unrecognized" fallback', function () {
            // A single-section anchor cannot exercise anchor-sections-card wiring
            // (that is the 'v0 bundle sections' describe block below), but it
            // still proves v0 resolves through ANCHOR_VERSION_TRAITS as a KNOWN,
            // bundle-shaped version rather than falling back to the row's shape.
            const $ = renderPage(BUNDLE);
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.equal('Checkpoint bundle (one per network)');
            expect($('.anchor-note').text()).to.not.contain('does not recognize');
            expect($('.anchor-note').text()).to.not.contain('Legacy');
        });
    });
});
