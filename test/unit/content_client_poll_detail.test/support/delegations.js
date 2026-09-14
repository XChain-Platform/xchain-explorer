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

const { expect, renderDom, paint, loadPage, OPEN_POLL, CLOSED_POLL, CLOSED_RESULTS, OPEN_VOTES, DELEGATIONS, POLL_URL, RESULT_URL, VOTES_URL, DLG_URL } = require('../../content_client_poll_detail.test.js');

describe('poll.html detail page @regression', function () {
    describe('delegations: live vs revoked', function () {

        it('[revoked] a CLEAR row is never listed or counted as a live delegation', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations(DELEGATIONS, 'GOVMT0XGKFM1'));

            const live = $('.poll-delegation-live');
            expect(live.length, 'only the two non-cleared delegations are live').to.equal(2);

            const liveDelegators = live.find('.poll-delegation-delegator').map(function () {
                return $(this).text().trim();
            }).get();
            expect(liveDelegators).to.deep.equal(['mDlgtA', 'mDlgtB']);
            expect(liveDelegators, 'the revoked delegator must not appear as live').to.not.include('mDlgtC');

            expect($('#poll-delegation-live-count').text().trim()).to.equal('2');
        });

        it('[revoked] the cleared row renders in the revoked state with no delegate', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations(DELEGATIONS, 'GOVMT0XGKFM1'));

            const revoked = $('.poll-delegation-revoked');
            expect(revoked.length).to.equal(1);
            expect(revoked.find('.poll-delegation-delegator').text().trim()).to.equal('mDlgtC');
            expect(revoked.find('.poll-delegation-delegate').text().trim()).to.equal('none');
            expect(revoked.find('.poll-delegation-delegate a').length, 'a revoked row links no delegate').to.equal(0);
            expect($('#poll-delegation-revoked-count').text().trim()).to.equal('1');
        });

        it('[live] a delegation with a delegate links both addresses', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations([DELEGATIONS[0]], 'GOVMT0XGKFM1'));
            expect($('.poll-delegation-live .poll-delegation-delegate a').attr('href'))
                .to.equal('/RBTC/address/mRepX');
            expect($('#poll-delegation-live-count').text().trim()).to.equal('1');
        });

        it('[empty] no delegations renders the empty state, not a table', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollDelegations([], 'GOVMT0XGKFM1'));
            expect($('#poll-delegation-empty').length).to.equal(1);
            expect($('#poll-delegation-table').length).to.equal(0);
            expect($('#poll-delegation-live-count').text().trim()).to.equal('0');
        });
    });
});
