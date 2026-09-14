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
        it('[ballots] wires the votes datatable to the registered poll feed', function () {
            const { window } = loadPage({
                [POLL_URL]:   OPEN_POLL,
                [RESULT_URL]: { total: 0, data: [] },
                [VOTES_URL]:  { total: 0, data: [] },
                [DLG_URL]:    { total: 0, data: [] }
            });
            expect(window.__datatable).to.deep.equal(['RBTC', 'vote', '4242', 'poll']);
        });

        it('[not found] an empty response is an explicit not-found, not a blank page', function () {
            const { $ } = loadPage({ [POLL_URL]: { total: 0, data: [] } });
            expect($('#poll-not-found').length).to.equal(1);
            expect($('#poll-not-found').text()).to.contain('No poll exists at this id');
            expect($('#poll-tally').text().trim()).to.equal('-');
        });

        it('[404] the error branch surfaces the API error string in text-danger', function () {
            const { $ } = loadPage({
                [POLL_URL]: { __fail: { status: 404, responseJSON: { error: 'poll not found', code: 'NOT_FOUND' } } }
            });
            expect($('#poll-load-error').length).to.equal(1);
            expect($('#poll-load-error').hasClass('text-danger')).to.equal(true);
            expect($('#poll-load-error').text()).to.equal('poll not found');
        });
    });
});
