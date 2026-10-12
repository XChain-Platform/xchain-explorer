/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { VOTE } = require('../../../../src/action-detail/governance.js');

const context = {
    db: { util: { isNull: value => value === null || value === undefined } },
    config: {},
    action_index: 1
};

describe('VOTE poll option parsing', function () {
    it('marks malformed options as unparseable', async function () {
        const data = { poll_status: 'open', options: '["Yes"' };

        await VOTE.afterMain(context, data);

        assert.deepStrictEqual(data.options, []);
        assert.strictEqual(data.options_unparseable, true);
    });

    it('leaves valid options unmarked', async function () {
        const data = { poll_status: 'open', options: '["Yes","No"]' };

        await VOTE.afterMain(context, data);

        assert.deepStrictEqual(data.options, ['Yes', 'No']);
        assert.ok(!data.options_unparseable);
    });

    it('leaves absent options empty and unmarked', async function () {
        const data = { poll_status: 'open' };

        await VOTE.afterMain(context, data);

        assert.deepStrictEqual(data.options, []);
        assert.ok(!data.options_unparseable);
    });
});
