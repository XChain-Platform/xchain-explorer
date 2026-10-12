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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { PRICE } = require('../../../../src/action-detail/consensus.js');

describe('PRICE action detail rounds JSON', function () {
    it('marks malformed rounds JSON as unparseable', function () {
        const data = { rounds_json: '{bad json' };

        PRICE.afterMain({ action_index: 1 }, data);

        assert.deepStrictEqual(data.rounds, []);
        assert.strictEqual(data.rounds_unparseable, true);
    });

    it('leaves valid round bodies unmarked', function () {
        const rounds = [{ round: 17, pairs: [{ pair: 'BTC/USD', price: '64000' }] }];
        const data = { rounds_json: JSON.stringify(rounds) };

        PRICE.afterMain({ action_index: 1 }, data);

        assert.deepStrictEqual(data.rounds, rounds);
        assert.ok(!data.rounds_unparseable);
    });

    it('leaves absent rounds JSON and the marker undefined', function () {
        const data = {};

        PRICE.afterMain({ action_index: 1 }, data);

        assert.strictEqual(data.rounds, undefined);
        assert.ok(!data.rounds_unparseable);
    });
});
