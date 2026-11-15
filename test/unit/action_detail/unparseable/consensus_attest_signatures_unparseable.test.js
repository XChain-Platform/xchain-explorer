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

const assert = require('assert');

const { ATTEST } = require('../../../../src/action-detail/consensus.js');

const context = {
    db: { util: { isNull: value => value === null || value === undefined } },
    config: {},
    action_index: 1
};

describe('ATTEST validator signatures parsing', function(){
    it('marks malformed validator signatures as unparseable', async function(){
        let data = { version: 1, validator_signatures: '{malformed' };

        await ATTEST.afterMain(context, data);

        assert.deepStrictEqual(data.signatures, []);
        assert.strictEqual(data.signatures_unparseable, true);
    });

    it('keeps valid validator signatures without the unparseable flag', async function(){
        let signatures = [{ validator: 'validator-1', signature: 'signature-1' }];
        let data = { version: 1, validator_signatures: JSON.stringify(signatures) };

        await ATTEST.afterMain(context, data);

        assert.deepStrictEqual(data.signatures, signatures);
        assert.ok(!data.signatures_unparseable);
    });

    it('defaults absent validator signatures without the unparseable flag', async function(){
        let data = { version: 1 };

        await ATTEST.afterMain(context, data);

        assert.deepStrictEqual(data.signatures, []);
        assert.ok(!data.signatures_unparseable);
    });
});
