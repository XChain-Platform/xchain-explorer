/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The six user-written cancel/edit list pages (order/swap/dispenser cancels
 * and edits), and the shared-scratch-variable fix in the dispenser/dispense
 * render branches.
 *
 * A list page needs THREE registrations, not one, and every missing piece
 * fails silently in a different way:
 *
 *  - no 'html' route: /{COIN}/order_cancels answers 404 on every coin;
 *  - no '/explorer' feed route: the page's ajax 404s and DataTables draws an
 *    empty table, which reads as "no records" rather than as a defect (the
 *    /explorer feed is what a page pages over - the /api feed these six
 *    already had is NOT the one loadDatatablesData asks for);
 *  - no getPagingDataResults row mapping: the feed serves raw objects and
 *    every cell renders blank, again with no error anywhere.
 *
 * On top of that, an EDIT row exists only for what it changed, so its
 * amended fields are nullable by design: a DISPENSER_EDIT that refilled the
 * escrow carries a null expiration and null lists. Those must reach the page
 * as a dash, never as the literal word "null" and never as an /action/null
 * href.
 *
 * The render assertions drive the SHIPPED createdRow closure against the
 * SHIPPED jQuery, so they fail on real behaviour rather than on a copy of it.
 * The harness is the one content-client-expire-list-pages.test.js uses.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    CLIENT_SRC, SRC_ADDR, renderRow
} = require('../content_client_cancel_edit_list_pages.test.js');

// The dispenser/dispense legs are values, not accumulations onto the shared
// createdRow scratch variable. Behaviour must not change, so each leg is compared
// byte-for-byte against the prior expression, same helpers, same realm.

const DISPENSER_TOKEN  = [1, 3400, 1787938500, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', 'CAMPE', '5',    0, 1290];
const DISPENSER_NATIVE = [1, 3400, 1787938500, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', null,    '1000', 0, 1290];
const DISPENSE_TOKEN   = [1, 3401, 1787938560, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', 'CAMPE', '5',    1, 1291];
const DISPENSE_NATIVE  = [1, 3401, 1787938560, SRC_ADDR, 'RDOGE', 'CAMPD', '10', 'RDOGE', null,    '1000', 1, 1291];

// Normalize a candidate string through the same .html() round trip the real
// cell went through, so the comparison is of rendered DOM, not of source text.
function throughDom(win, str){
    return win.jQuery('<td>').html(str).html();
}

describe('dispenser/dispense legs are values, not shared scratch state', function () {

    it('renders a NATIVE-coin get leg byte-identically to the pre-refactor expression', function () {
        for(const [action, data] of [['dispenser', DISPENSER_NATIVE], ['dispense', DISPENSE_NATIVE]]){
            const { win, html } = renderRow(action, data, 7);
            const getCoin   = data[7];
            const getAmount = data[9];
            // The expression both branches carried before the refactor, verbatim.
            const legacy = ' <i class="fa ' + win.getNetworkIcon() + '"></i> '
                         + win.escapeHtml(getAmount) + ' ' + win.escapeHtml(getCoin);
            expect(html[5], `${action} native get leg changed`).to.equal(throughDom(win, legacy));
            // And it is really the native rendering: an icon, no token link.
            expect(html[5], `${action} native leg must carry the network icon`).to.include('<i class="fa ');
            expect(html[5], `${action} native leg must not link a token`).to.not.include('/token/');
        }
    });

    it('renders a TOKEN get leg byte-identically to the pre-refactor expression', function () {
        for(const [action, data] of [['dispenser', DISPENSER_TOKEN], ['dispense', DISPENSE_TOKEN]]){
            const { win, html } = renderRow(action, data, 7);
            const getCoin   = data[7];
            const getToken  = data[8];
            const getAmount = data[9];
            const legacy = win.formatLinkAmount('/' + getCoin + '/token/' + getToken, getToken, getToken, getAmount);
            expect(html[5], `${action} token get leg changed`).to.equal(throughDom(win, legacy));
            expect(html[5], `${action} token leg must link the token`).to.include('/RDOGE/token/CAMPE');
        }
    });

});

describe('dispenser/dispense legs are values, not shared scratch state', function () {

// The give leg shares the cell above it and must be unaffected by the change.
    it('leaves the give leg unchanged for both a token and a native get leg', function () {
        for(const data of [DISPENSER_TOKEN, DISPENSER_NATIVE]){
            const { html } = renderRow('dispenser', data, 7);
            expect(html[4], 'give leg').to.include('/RDOGE/token/CAMPD');
        }
    });

    // The actual defect: `html` is the createdRow scratch variable, declared once
    // for the whole function and never reset between branches. Appending a leg
    // onto it made both cells inherit whatever an earlier matching branch had
    // left there. Nothing writes to it above these two today, which is exactly
    // why this was latent rather than visible - so the guard is on the SOURCE.
    it('never reads or writes the shared `html` scratch variable in either branch', function () {
        const start = CLIENT_SRC.indexOf("if(action=='dispenser'){");
        const end   = CLIENT_SRC.indexOf("if(action=='dividend'){");
        expect(start, "the dispenser render branch was not found").to.be.greaterThan(-1);
        expect(end,   "the dividend render branch (end marker) was not found").to.be.greaterThan(start);
        const body = CLIENT_SRC.slice(start, end);
        const hits = [...body.matchAll(/(^|[^.\w])html\s*\+?=[^=]/g)].map(m => m[0].trim());
        expect(hits, 'the dispenser/dispense branches still build a leg on the shared\n'
            + '`html` scratch variable; a branch added above them that touches it\n'
            + 'would silently prefix its content into both legs:\n  ' + hits.join('\n  ')).to.deep.equal([]);
    });

});
