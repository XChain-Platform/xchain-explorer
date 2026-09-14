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
    describe('activation gate: rows before ANCHOR_ACTIVATION', function () {
        it('[TRAP] a v1-shaped row below testnet activation ALSO renders as Legacy, never as today\'s v1', function () {
            // The exact misreading D7 exists to prevent: a legacy version byte 1
            // meant something else before the restart, and collapsing the
            // traits table without this gate would relabel it with TODAY'S v1
            // meaning ("Archive head + publisher tail") instead of flagging it.
            const $ = renderPage(Object.assign({}, V1, {
                network: 'testnet', block_index_doge: 150174, status: 'valid'
            }));
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.not.equal('Archive head + publisher tail');
            expect($('.anchor-kind').text()).to.not.equal('Archive continuation chunk');
        });

        it('a row AT the activation height is judged on its version, not flagged legacy (>= is the boundary)', function () {
            const $ = renderPage(Object.assign({}, V1, {
                network: 'testnet', block_index_doge: 67858600, status: 'valid'
            }));
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
        });

        it('regtest has no activation history (ANCHOR_ACTIVATION.regtest = 0), so a regtest row is never flagged legacy', function () {
            const $ = renderPage(Object.assign({}, V1, { block_index_doge: 0 }));
            expect($('.anchor-kind').text()).to.not.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
        });
    });
});
