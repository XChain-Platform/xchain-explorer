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
    /* --------------------------- page wiring -------------------------- */

    describe('page wiring (anchor.html inline script)', function () {

        it('fetches the composed anchor endpoint directly and renders a BARE object response', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': V5 });
            expect(page.seen).to.deep.equal(['/RDOGE/api/anchor/1006']);
            expect(page.$('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect(page.$('.anchor-reward-row').length).to.equal(1);
        });

        it('also accepts the {total, data} envelope shape', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { total: 1, data: [V5] } });
            expect(page.$('.anchor-height-broadcast .anchor-height-value').text()).to.equal('2,503');
        });

        it('[NOT FOUND] a 404 renders the endpoint error explicitly, not blank placeholders', function () {
            const page = loadPage({});
            const msg = page.$('#anchor-identity .anchor-message');
            expect(msg.length).to.equal(1);
            expect(msg.text()).to.equal('anchor not found');
            expect(msg.hasClass('text-danger')).to.equal(true);
            expect(page.$('#anchor-identity').text()).to.not.contain('Loading anchor');
            expect(page.$('#anchor-archive-card').hasClass('d-none')).to.equal(true);
        });

        it('[NOT FOUND] a 200 with an empty envelope renders the no-such-anchor branch', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { total: 0, data: [] } });
            const msg = page.$('#anchor-identity .anchor-message');
            expect(msg.text()).to.equal('No anchor matches this action index or transaction hash.');
            expect(msg.hasClass('text-danger'), 'no such anchor is not a server error').to.equal(false);
        });

        it('a failed request without a JSON body still says something concrete', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { __fail: { status: 500 } } });
            expect(page.$('#anchor-identity .anchor-message').text()).to.equal('Could not load this anchor');
        });

        it('leaves no panel showing its loading placeholder after a response', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': V5 });
            for (const id of ['#anchor-identity', '#anchor-heights', '#anchor-checkpoint-payload',
                              '#anchor-covering-checkpoint', '#anchor-election', '#anchor-rewards'])
                expect(page.$(id).text(), id + ' still shows its placeholder').to.not.contain('Loading');
        });
    });
});
