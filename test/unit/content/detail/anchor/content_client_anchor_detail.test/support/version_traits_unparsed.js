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
 * An ANCHOR whose version byte the indexer could not read as 0 to 255 is
 * stored as version 0 under 'invalid: VERSION (unknown)'. A real v0 is never
 * given that status, so the pair must not render as a v0 checkpoint bundle.
 */

'use strict';

const { expect, renderPage, V1, BUNDLE, BUNDLE_SECTIONS, LEGACY_TESTNET_BUNDLE } = require('../../content_client_anchor_detail.test.js');

const UNPARSED_STATUS = 'invalid: VERSION (unknown)';

describe('anchor.html detail render @regression', function () {
    describe('version traits: an unread version byte', function () {
        const unparsed = Object.assign({}, BUNDLE, {
            status: UNPARSED_STATUS, section_count: 1, sections: [BUNDLE_SECTIONS[0]]
        });

        it('[TRAP] stored version 0 under the unknown-version status is not a v0 checkpoint bundle', function () {
            const $ = renderPage(unparsed);
            expect($('.anchor-version-badge').text()).to.equal('v?');
            expect($('.anchor-kind').text()).to.equal('Unrecognized version');
            expect($('body').text()).to.not.contain('Checkpoint bundle');
            expect($('.anchor-bundle-chains-row').length).to.equal(0);
            expect($('#anchor-sections-card').hasClass('d-none')).to.equal(true);
        });

        it('names the stored status in the note and keeps the status badge', function () {
            const $ = renderPage(unparsed);
            expect($('.anchor-field-value .anchor-note').first().text())
                .to.contain('could not be read as a number from 0 to 255')
                .and.to.contain('Stored status: ' + UNPARSED_STATUS);
            expect($('.anchor-status-badge').text()).to.contain(UNPARSED_STATUS);
        });

        it('keeps a real v0 under any other status as a checkpoint bundle', function () {
            const $ = renderPage(Object.assign({}, unparsed, { status: 'invalid: SIGNATURE' }));
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.contain('Checkpoint bundle');
        });

        it('keeps a stored byte from 4 to 255 under the same status as its own unrecognized version', function () {
            const $ = renderPage(Object.assign({}, V1, {
                version: 9, status: UNPARSED_STATUS,
                checkpoint: Object.assign({}, V1.checkpoint, { block_hash: 'ff'.repeat(32) })
            }));
            expect($('.anchor-version-badge').text()).to.equal('v9');
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v9');
            expect($('#anchor-identity').text()).to.contain('PayloadNot decoded for this version');
            expect($('#anchor-identity').text()).to.not.contain(V1.chain);
            expect($('#anchor-heights .anchor-height-checkpointed').length).to.equal(0);
            expect($('#anchor-checkpoint-payload').text()).to.contain('payload fields are not shown');
            expect($('#anchor-covering-checkpoint .anchor-mirror-agreement').length).to.equal(0);
            expect($('#anchor-election .anchor-publisher').length).to.equal(0);
            expect($('.anchor-field-value .anchor-note').first().text()).to.contain('v1 archive-head layout');
        });

        it('lets the legacy label win below activation', function () {
            const $ = renderPage(Object.assign({}, LEGACY_TESTNET_BUNDLE, { status: UNPARSED_STATUS }));
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
        });

        it('prints v? for an unread version in the chunk table and v0 for a real v0 chunk', function () {
            const chunks = [
                Object.assign({}, V1.chunks[0], { version: 0, status: UNPARSED_STATUS }),
                Object.assign({}, V1.chunks[1], { version: 0, status: 'valid' })
            ];
            const $ = renderPage(Object.assign({}, V1, { chunks }));
            const cells = $('#anchor-archive-payload .anchor-chunk-row').map(function () {
                return $(this).find('td').eq(2).text();
            }).get();
            expect(cells).to.deep.equal(['v?', 'v0']);
        });
    });
});
