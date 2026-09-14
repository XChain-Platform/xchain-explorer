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
    describe('escaping', function () {

        it('an attacker-controlled option label never reaches the DOM as markup', function () {
            const dom = renderDom();
            const evil = Object.assign({}, OPEN_POLL, { options: ['<img src=x onerror=alert(1)>', 'ok'] });
            const $ = paint(dom, dom.window.renderPollTally(evil, [], []));
            expect($('#poll-tally-table img').length).to.equal(0);
            expect($('.poll-tally-row').first().text()).to.contain('<img src=x onerror=alert(1)>');
        });
    });
});
