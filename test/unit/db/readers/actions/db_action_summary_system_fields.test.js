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
 * Pins compact summary projection for system and bridge scalar fields.
 */

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const db = new Database(mockExplorer);

describe('action summary system fields', function () {
    it('projects BET_EXPIRE feed and refund fields', function () {
        const out = db.projectActionSummary({
            action: 'BET_EXPIRE', status: 'valid', feed_action_index: 1193,
            tick: 'DANK', refund_count: 2, refund_amount: '15.5'
        });
        expect(out.details).to.include({
            feed_action_index: 1193, tick: 'DANK', refund_count: 2, refund_amount: '15.5'
        });
    });

    it('projects ROLLCALL epoch height without long or array fields', function () {
        const out = db.projectActionSummary({
            action: 'ROLLCALL', epoch_height: 4200,
            publisher: 'ab'.repeat(32), signers: [{ pubkey: 'p1' }], gates: []
        });
        expect(out.details).to.include({ epoch_height: 4200 });
        expect(out.details).not.to.have.any.keys('publisher', 'signers', 'gates');
    });

    it('projects XBRIDGE routing fields and preserves nulls', function () {
        const out = db.projectActionSummary({
            action: 'XBRIDGE', action_format: 0, tick: 'DANK',
            dest_chain: 'DOGE', dest_address: 'addrD', bridge_kind: null,
            transfer_id: null, memo: 'm'
        });
        expect(out.details).to.include({
            action_format: 0, tick: 'DANK', dest_chain: 'DOGE',
            dest_address: 'addrD', bridge_kind: null, transfer_id: null
        });
        expect(out.details).not.to.have.key('memo');
    });

    it('projects COINPAY_EXPIRE obligation action index', function () {
        const out = db.projectActionSummary({
            action: 'COINPAY_EXPIRE', status: 'valid', obligation_action_index: 77
        });
        expect(out.details).to.include({ obligation_action_index: 77 });
    });

    it('leaves details false when no summary field is present', function () {
        const out = db.projectActionSummary({ action: 'ANCHOR', status: 'valid' });
        expect(out.details).to.equal(false);
    });
});
