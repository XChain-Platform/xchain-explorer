/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const { LIST } = require('../../../../src/action-detail/misc.js');

describe('LIST union detail rows', function () {
    it('returns member list action indexes in numeric order', function () {
        const data = { type: 3 };
        LIST.afterQuery2({}, data, [{ item_id: 10 }, { item_id: 9 }]);
        assert.deepEqual(data.list, [9, 10]);
    });

    it('does not read a union member through an unrelated joined address or tick', function () {
        const data = { type: 3 };
        LIST.afterQuery2({}, data, [{ item_id: 42, address: 'wrong', tick: 'WRONG' }]);
        assert.deepEqual(data.list, [42]);
    });
});
