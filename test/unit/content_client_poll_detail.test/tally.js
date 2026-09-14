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
    describe('tally', function () {

        it('[closed] tallies from poll_results and badges the winning option', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(CLOSED_POLL, CLOSED_RESULTS, []));
            expect($('#poll-tally-metric').text().trim()).to.equal('Weight');
            const weights = $('.poll-tally-weight').map(function () { return $(this).text().trim(); }).get();
            expect(weights).to.deep.equal(['300', '900']);
            const winner = $('.poll-tally-winner');
            expect(winner.length).to.equal(1);
            expect(winner.text()).to.contain('Hold');
            expect($('#poll-tally-basis').text()).to.contain('Final tally');
        });

        it('[open] shows a provisional BALLOT count, never a weight', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], OPEN_VOTES));
            expect($('#poll-tally-metric').text().trim()).to.equal('Ballots');
            expect($('.poll-tally-weight').length, 'no weight column on an unfinalized poll').to.equal(0);
            expect($('#poll-tally-basis').text()).to.contain('not voting weight');
            expect($('.poll-tally-winner').length, 'an open poll has no winner').to.equal(0);
        });

        it('[open] a superseded re-vote is not counted against the option it moved off', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], OPEN_VOTES));
            const counts = $('.poll-tally-ballots').map(function () { return $(this).text().trim(); }).get();
            // mVoterA moved from option 0 to option 1, so option 0 holds nothing.
            expect(counts).to.deep.equal(['0', '2']);
        });

        it('[open] no ballots at all still renders every option', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderPollTally(OPEN_POLL, [], []));
            expect($('.poll-tally-row').length).to.equal(2);
            expect($('.poll-tally-ballots').map(function () { return $(this).text().trim(); }).get())
                .to.deep.equal(['0', '0']);
        });
    });
});
