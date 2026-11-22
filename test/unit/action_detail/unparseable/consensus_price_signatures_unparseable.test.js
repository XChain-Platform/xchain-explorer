// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { PRICE } = require('../../../../src/action-detail/consensus');

describe('PRICE signature JSON parsing', function () {
    it('marks malformed signature JSON as unparseable', function () {
        const data = { sigs_json: '{bad json' };

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.deep.equal([]);
        expect(data.signatures_unparseable).to.equal(true);
    });

    it('does not mark valid signature JSON as unparseable', function () {
        const signatures = [{ pubkey: 'validator', signature: 'proof' }];
        const data = { sigs_json: JSON.stringify(signatures) };

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.deep.equal(signatures);
        expect(data.signatures_unparseable).to.not.be.ok;
    });

    it('leaves signatures absent when signature JSON is absent', function () {
        const data = {};

        PRICE.afterMain({ action_index: 1 }, data);

        expect(data.signatures).to.equal(undefined);
        expect(data.signatures_unparseable).to.not.be.ok;
    });
});
