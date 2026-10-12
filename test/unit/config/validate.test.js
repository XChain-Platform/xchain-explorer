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

const assert = require('assert');
const {
    describeHubResponse,
    requireUsableConfig
} = require('../../../src/config/validate');

function stubConfigUtil(){
    const messages = [];
    return {
        messages,
        isNull: value => value === null,
        throwError: message => messages.push(message)
    };
}

describe('config validation', function(){

    describe('describeHubResponse', function(){

        it('describes a null response as an unreachable hub returning nothing', function(){
            const result = describeHubResponse(stubConfigUtil(), null);

            assert.deepStrictEqual(result, {
                unreachable: true,
                returnedNothing: true,
                cause: 'Hub unreachable (all endpoints failed after retries)'
            });
        });

        it('describes an empty response as a reachable hub returning nothing', function(){
            const result = describeHubResponse(stubConfigUtil(), {});

            assert.deepStrictEqual(result, {
                unreachable: false,
                returnedNothing: true,
                cause: 'Hub reachable but serving no coin config'
            });
        });

        it('describes a populated response as reachable and non-empty', function(){
            const result = describeHubResponse(stubConfigUtil(), { BTC: {} });

            assert.strictEqual(result.unreachable, false);
            assert.strictEqual(result.returnedNothing, false);
        });
    });

    describe('requireUsableConfig', function(){

        it('reports the validation error for a null response', function(){
            const configUtil = stubConfigUtil();

            requireUsableConfig(configUtil, null);

            assert.deepStrictEqual(configUtil.messages, [
                'No valid configuration information detected'
            ]);
        });

        it('does nothing for a non-null response', function(){
            const configUtil = stubConfigUtil();

            requireUsableConfig(configUtil, {});

            assert.deepStrictEqual(configUtil.messages, []);
        });
    });
});
