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

// Unit contract for parsing replay metadata and withholding finality at an open target.

const assert = require('assert');

const {
    REPLAY_STATES,
    replayIsOpen,
    heightIsFinal,
    parseReplay
} = require('../../../src/explorer/replay_finality.js');

function replay(state, target = 10){
    return { state, target, replay_to: 20 };
}

describe('replay finality rules @regression', function(){
    it('publishes the frozen replay-state vocabulary', function(){
        assert.deepStrictEqual(REPLAY_STATES, ['pending', 'replaying', 'replayed']);
        assert.strictEqual(Object.isFrozen(REPLAY_STATES), true);
    });

    it('recognises only pending and replaying bodies as open', function(){
        assert.strictEqual(replayIsOpen(replay('pending')), true);
        assert.strictEqual(replayIsOpen(replay('replaying')), true);
        assert.strictEqual(replayIsOpen(replay('replayed')), false);
        assert.strictEqual(replayIsOpen(null), false);
        assert.strictEqual(replayIsOpen(undefined), false);
        assert.strictEqual(replayIsOpen({ state: 'done' }), false);
    });

    it('withholds finality at and above an open replay target', function(){
        for(const state of ['pending', 'replaying']){
            assert.strictEqual(heightIsFinal(9, replay(state)), true);
            assert.strictEqual(heightIsFinal(10, replay(state)), false);
            assert.strictEqual(heightIsFinal(11, replay(state)), false);
        }
    });

    it('keeps both sides of a replayed target final', function(){
        assert.strictEqual(heightIsFinal(9, replay('replayed')), true);
        assert.strictEqual(heightIsFinal(10, replay('replayed')), true);
    });

    it('keeps heights final when replay metadata is absent', function(){
        assert.strictEqual(heightIsFinal(10, null), true);
        assert.strictEqual(heightIsFinal(10, undefined), true);
    });

    it('compares string heights and targets from the JSON body numerically', function(){
        const body = replay('pending', '10');
        assert.strictEqual(heightIsFinal('9', body), true);
        assert.strictEqual(heightIsFinal('10', body), false);
    });

    it('returns null when the rules body or replay field is absent', function(){
        assert.strictEqual(parseReplay(undefined), null);
        assert.strictEqual(parseReplay({}), null);
        assert.strictEqual(parseReplay({ replay: null }), null);
    });

    it('coerces replay heights into a new object without mutating the input', function(){
        const rules = { replay: { state: 'replaying', target: '10', replay_to: '20' } };
        const before = JSON.stringify(rules);

        assert.deepStrictEqual(parseReplay(rules), {
            state: 'replaying', target: 10, replay_to: 20
        });
        assert.strictEqual(JSON.stringify(rules), before);
    });

    it('keeps a null replay_to value null', function(){
        assert.deepStrictEqual(parseReplay({
            replay: { state: 'pending', target: 5, replay_to: null }
        }), { state: 'pending', target: 5, replay_to: null });
    });

    it('rejects an unknown replay state', function(){
        assert.throws(() => parseReplay({ replay: replay('done', 1) }), /Invalid replay state/);
    });

    it('rejects negative, non-numeric, fractional, and unsafe targets', function(){
        for(const target of [-1, 'x', 1.5, Number.MAX_SAFE_INTEGER + 1]){
            assert.throws(
                () => parseReplay({ replay: replay('pending', target) }),
                /Invalid replay target/
            );
        }
    });
});
