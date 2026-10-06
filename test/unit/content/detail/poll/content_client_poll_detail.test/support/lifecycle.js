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
    describe('open vs closed', function () {

        it('[open] an open poll reads as still accepting ballots, with no result', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(OPEN_POLL));
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(true);
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(false);
            expect($('#poll-winning-option').length, 'an open poll has no winning option').to.equal(0);
            expect($('#poll-outcome-state').text()).to.contain('Open');
        });

        it('[closed] a closed poll reads as a result, naming the winning option label', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(CLOSED_POLL));
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(true);
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(false);
            expect($('#poll-winning-option').text().trim()).to.equal('Hold');
            expect($('#poll-outcome-state').text()).to.contain('decided early');
        });

        it('[closed] a poll that failed shows the fail reason', function () {
            const dom = renderDom();
            const failed = Object.assign({}, CLOSED_POLL, {
                poll_status: 'failed', winning_option: null, fail_reason: 'quorum'
            });
            const $ = paint(dom, dom.window.renderPollOutcome(failed));
            expect($('#poll-fail-reason').text()).to.contain('quorum');
            expect($('#poll-winning-option').length).to.equal(0);
        });

        it('[status] an unknown lifecycle state never renders as open', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollOutcome(Object.assign({}, OPEN_POLL, { poll_status: null })));
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(false);
        });
    });
});
