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
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { explorerRowContext } = require('../../../../src/explorer/paging/explorer_row.js');

const ctx = { method: 'getHistoryData', cfg: {}, count: 1, count_reverse: 1 };
const util = {};

describe('explorer row action status mapping', function () {
    it('keeps valid and invalid status codes stable', function () {
        expect(explorerRowContext(util, { action: 'SEND', status: 'valid' }, ctx).status).to.equal(1);
        expect(explorerRowContext(util, { action: 'SEND', status: 'invalid: reason' }, ctx).status).to.equal(0);
    });

    it('keeps the packed status slot numeric when a payload carries no status', function () {
        expect(explorerRowContext(util, { action: 'ROLLCALL' }, ctx).status).to.equal(0);
        expect(explorerRowContext(util, { action: 'NODEPROOF', status: null }, ctx).status).to.equal(0);
        expect(explorerRowContext(util, { action: 'ROLLCALL', status: 'valid' }, ctx).status).to.equal(1);
    });

    it('accepts pending only for UNSTAKE', function () {
        expect(explorerRowContext(util, { action: 'SEND', status: 'pending' }, ctx).status).to.equal(0);
        const unstakeCtx = Object.assign({}, ctx, { method: 'getUnstakes' });
        expect(explorerRowContext(util, { status: 'completed' }, unstakeCtx).status).to.equal(1);
    });

    it('accepts UNSTAKE lifecycle statuses without widening other actions', function () {
        expect(explorerRowContext(util, { action: 'UNSTAKE', status: 'pending' }, ctx).status).to.equal(0);
        expect(explorerRowContext(util, { action: 'UNSTAKE', status: 'completed' }, ctx).status).to.equal(1);
        expect(explorerRowContext(util, { action: 'SEND', status: 'completed' }, ctx).status).to.equal(0);
    });
});
