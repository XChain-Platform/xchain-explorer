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
    describe('quorum gates', function () {

        it('[open] an unmeasured gate reads as not-yet-measured, never as failed', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollQuorum(OPEN_POLL));
            expect($('#poll-quorum-table').text()).to.contain('not yet measured');
            expect($('#poll-quorum-table').text()).to.not.contain('not met');
        });

        it('[closed] a measured gate reads met/not met', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollQuorum(
                Object.assign({}, CLOSED_POLL, { quorum_met: 0, min_voters_met: 1 })));
            const text = $('#poll-quorum-table').text();
            expect(text).to.contain('not met');
            expect(text).to.contain('met');
            expect(text).to.not.contain('not yet measured');
        });
    });
});
