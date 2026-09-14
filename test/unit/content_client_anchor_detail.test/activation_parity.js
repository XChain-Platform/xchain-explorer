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
    /* ------------------- activation gate: legacy rows ------------------ */

    // content/js ships as plain static scripts with no bundler, so the browser
    // copy of ANCHOR_ACTIVATION cannot require() this service's canonical
    // module and is instead a hand-vendored literal. That is a silent-drift
    // seam: the server would gate at one height and the page label at another,
    // and every symptom would look like a rendering bug. Pin the two together
    // here, against the SHIPPED script the renders run from.
    describe('ANCHOR_ACTIVATION twin parity (client literal vs. the module)', function () {

        it('the browser copy equals src/protocol/constants.js exactly', function () {
            const canonical = require('../../../src/protocol/constants.js').ANCHOR_ACTIVATION;
            const shipped   = domWithPage().window.ANCHOR_ACTIVATION;
            expect(shipped, 'the render script must declare ANCHOR_ACTIVATION').to.be.an('object');
            expect(shipped).to.deep.equal(canonical);
            // deepEqual alone would pass if BOTH sides lost a network, so pin
            // the key set the gate switches on as well.
            expect(Object.keys(shipped).sort()).to.deep.equal(['mainnet', 'regtest', 'testnet']);
        });
    });
});
