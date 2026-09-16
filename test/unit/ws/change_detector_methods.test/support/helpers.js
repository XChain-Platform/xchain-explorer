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
 * Unit tests for src/ws/change_detector.js: the indexer-DB poller that turns
 * new blocks/actions into WebSocket events. All collaborators are injected, so
 * no real DB or timers are needed (fake timers used only for the poll loop).
 */

'use strict';

const sinon = require('sinon');
const ChangeDetector = require('../../../../../src/ws/change_detector.js');

function mk(over) {
    over = over || {};
    let db = {
        getMaxBlockIndex:            sinon.stub().resolves(0),
        getMaxActionIndex:           sinon.stub().resolves(0),
        getBlocksSince:              sinon.stub().resolves([]),
        getActionsSince:             sinon.stub().resolves([]),
        getOrderMatchSettlement:     sinon.stub().resolves(null),
        getDispenseDispenserIndex:   sinon.stub().resolves(null),
        getCoinpayObligation:        sinon.stub().resolves(null),
        getAddressBalances:          sinon.stub().resolves([]),
        getTokenInfo:                sinon.stub().resolves(null),
        getDispenserInfo:            sinon.stub().resolves(null),
        getMarketInfo:               sinon.stub().resolves(null),
        getAttestationByActionIndex: sinon.stub().resolves(null)
    };
    let channelManager = over.channelManager === null ? null : {
        getSubscribedAddresses:  sinon.stub().returns(new Set()),
        getSubscribedTicks:      sinon.stub().returns(new Set()),
        getSubscribedDispensers: sinon.stub().returns(new Set()),
        getSubscribedMarkets:    sinon.stub().returns([])
    };
    return new ChangeDetector({ db, channelManager, pollInterval: 5000, fetchLimit: 100 });
}

// Inclusive integer range [a..b].
function range(a, b) { let r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

module.exports = { mk, range };
