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
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    DEFAULT_CURSOR,
    CURSOR_BY_METHOD,
    ID_KEYED_METHODS,
    cursorField
} = require('../../../../src/db/query_sql/offset_cursors');

describe('offset_cursors', () => {
    it('DEFAULT_CURSOR is m.action_index', () => {
        assert.strictEqual(DEFAULT_CURSOR, 'm.action_index');
    });

    it('maps the explicitly keyed methods to their own columns', () => {
        assert.strictEqual(cursorField('getBlocks'), 'b1.block_index');
        assert.strictEqual(cursorField('getTokens'), 'm.id');
        assert.strictEqual(cursorField('getCollectibles'), 'm.id');
        assert.strictEqual(cursorField('getCheckpoints'), 'm.block_index');
        assert.strictEqual(cursorField('getCommitments'), 'm.block_index');
        // rollcalls ORDERs BY its primary key, so its cursor is the epoch height.
        assert.strictEqual(cursorField('getRollcallCloses'), 'm.epoch_height');
        // validator_rewards ORDERs BY m.id, so its explorer cursor is the id.
        assert.strictEqual(cursorField('getValidatorRewards'), 'm.id');
    });

    describe('ID_KEYED_METHODS', () => {
        it('has 20 entries with no duplicates', () => {
            assert.strictEqual(ID_KEYED_METHODS.length, 20);
            assert.strictEqual(new Set(ID_KEYED_METHODS).size, 20);
        });

        it('resolves every entry to m.id', () => {
            for(const method of ID_KEYED_METHODS)
                assert.strictEqual(cursorField(method), 'm.id', method);
        });
    });

    describe('fallback to DEFAULT_CURSOR', () => {
        it('applies to an unlisted method and an undefined method', () => {
            assert.strictEqual(cursorField('getSends'), DEFAULT_CURSOR);
            assert.strictEqual(cursorField('getDestroys'), DEFAULT_CURSOR);
            assert.strictEqual(cursorField(undefined), DEFAULT_CURSOR);
        });

        it('does not return inherited prototype values', () => {
            for(const name of ['constructor', '__proto__', 'hasOwnProperty'])
                assert.strictEqual(cursorField(name), DEFAULT_CURSOR, name);
        });
    });

    it('CURSOR_BY_METHOD has 26 own keys', () => {
        assert.strictEqual(Object.keys(CURSOR_BY_METHOD).length, 26);
    });
});
