'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

require('./utility.test/support/numbers.js');
require('./utility.test/support/objects.js');
require('./utility.test/support/time_and_io.js');

const { expect, makeUtil } = require('./utility.test/support/helpers.js');
const { assembleResponse } = require('../../../src/explorer/request/assemble_response.js');

describe('Utility custody address handling', function () {
    const custodyAddress = 'C:DOGE:2154';

    it('accepts a derived contract custody address', function () {
        expect(makeUtil().isAddressLike(custodyAddress)).to.equal(true);
    });

    it('rejects malformed colon-delimited addresses', function () {
        const util = makeUtil();
        expect(util.isAddressLike('C:DOGE:')).to.equal(false);
        expect(util.isAddressLike('C:DOGE:2154:1')).to.equal(false);
        expect(util.isAddressLike('C:DOGE:<script>')).to.equal(false);
    });

    it('echoes the requested custody address in a balances response', function () {
        const response = {};
        const explorer = {
            util: makeUtil(),
            getPagingDataResults: (cfg, data) => data
        };
        const state = {
            cfg: {
                type: 'api',
                data: { method: 'getBalances', search: custodyAddress }
            },
            total: 1,
            data: [{ tick: 'DOGE', amount: '1' }],
            response
        };

        assembleResponse(explorer, state);

        expect(response.json.address).to.equal(custodyAddress);
    });
});
