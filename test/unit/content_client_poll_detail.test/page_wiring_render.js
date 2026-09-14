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

const { expect, renderDom, paint, loadPage, OPEN_POLL, CLOSED_POLL, CLOSED_RESULTS, OPEN_VOTES, DELEGATIONS, POLL_URL, RESULT_URL, VOTES_URL, DLG_URL } = require('../content_client_poll_detail.test.js');

describe('poll.html detail page @regression', function () {
    describe('page wiring', function () {
        it('[open] renders a bare-object poll response end to end', function () {
            const { $ } = loadPage({
                [POLL_URL]:   OPEN_POLL,
                [RESULT_URL]: { total: 0, data: [] },
                [VOTES_URL]:  { total: OPEN_VOTES.length, data: OPEN_VOTES },
                [DLG_URL]:    { total: DELEGATIONS.length, data: DELEGATIONS }
            });
            expect($('#poll-question').text()).to.contain('Should the treasury fund the audit?');
            expect($('#poll-status-value').text().trim()).to.equal('open');
            expect($('#poll-tick').text()).to.contain('GOVMT0XGKFM1');
            expect($('#poll-outcome-state').hasClass('poll-outcome-open')).to.equal(true);
            expect($('#poll-tally-metric').text().trim()).to.equal('Ballots');
            expect($('.poll-delegation-live').length).to.equal(2);
            expect($('.poll-delegation-revoked').length).to.equal(1);
        });

        it('[closed] a finalized poll renders its frozen results', function () {
            const { $ } = loadPage({
                [POLL_URL]:   { total: 1, data: [CLOSED_POLL] },
                [RESULT_URL]: { total: 2, data: CLOSED_RESULTS },
                [DLG_URL]:    { total: 0, data: [] }
            });
            expect($('#poll-status-value').text().trim()).to.equal('passed');
            expect($('#poll-outcome-state').hasClass('poll-outcome-closed')).to.equal(true);
            expect($('#poll-tally-metric').text().trim()).to.equal('Weight');
            expect($('.poll-tally-winner').text()).to.contain('Hold');
        });
    });
});
