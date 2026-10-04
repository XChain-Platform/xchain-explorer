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
const { createMovePolicy } = require('../../../../../src/hub/hub_db_sync/failover/move_policy.js');

describe('createMovePolicy', function () {
    it('moves after the configured failure streak when alternatives exist', function () {
        const clock = 1000;
        const policy = createMovePolicy({ now: () => clock });

        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'move');
    });

    it('keeps retrying when there is only one candidate', function () {
        let clock = 1000;
        const policy = createMovePolicy({ now: () => clock });

        for (let attempt = 0; attempt < 10; attempt += 1) {
            assert.strictEqual(policy.onConnectFailure(1), 'retry');
            clock += 1;
        }
    });

    it('resets failures on a move and enforces the reconnect dwell', function () {
        let clock = 5000;
        const policy = createMovePolicy({ now: () => clock });

        policy.onConnectFailure(2);
        policy.onConnectFailure(2);
        policy.noteMove('stall');
        assert.strictEqual(policy.status().failureStreak, 0);
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');

        clock += 120000;
        assert.strictEqual(policy.onConnectFailure(2), 'move');
    });

    it('resets the failure streak after connecting', function () {
        const policy = createMovePolicy();

        policy.onConnectFailure(2);
        policy.onConnectFailure(2);
        policy.noteConnected();

        assert.strictEqual(policy.status().failureStreak, 0);
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
    });
});

describe('createMovePolicy stalls', function () {
    it('exits, moves, or holds stalled connections based on candidates and dwell', function () {
        let clock = 7000;
        const policy = createMovePolicy({ now: () => clock });

        assert.strictEqual(policy.onStall(1), 'exit');
        assert.strictEqual(policy.onStall(2), 'move');
        policy.noteMove('stall');
        assert.strictEqual(policy.onStall(2), 'hold');

        clock += 120000;
        assert.strictEqual(policy.onStall(2), 'move');
    });
});

describe('createMovePolicy options and status', function () {
    it('falls back from invalid reconnect attempt options', function () {
        for (const reconnectAttempts of [0, -1, 1.5, '3']) {
            const policy = createMovePolicy({ reconnectAttempts });

            assert.strictEqual(policy.onConnectFailure(2), 'retry');
            assert.strictEqual(policy.onConnectFailure(2), 'retry');
            assert.strictEqual(policy.onConnectFailure(2), 'move');
        }
    });

    it('falls back from invalid dwell options and honours zero', function () {
        for (const minDwellMs of [-1, 1.5]) {
            let clock = 9000;
            const policy = createMovePolicy({ minDwellMs, now: () => clock });

            policy.noteMove('stall');
            clock += 119999;
            assert.strictEqual(policy.onStall(2), 'hold');
            clock += 1;
            assert.strictEqual(policy.onStall(2), 'move');
        }

        const zeroDwellPolicy = createMovePolicy({ minDwellMs: 0 });
        zeroDwellPolicy.noteMove('stall');
        assert.strictEqual(zeroDwellPolicy.onStall(2), 'move');
    });

    it('reports initial and moved status', function () {
        const clock = 11000;
        const policy = createMovePolicy({ now: () => clock });

        assert.deepStrictEqual(policy.status(), {
            lastMoveAt: null,
            moveReason: null,
            moveCount: 0,
            failureStreak: 0
        });

        policy.onConnectFailure(2);
        policy.noteMove('stall');
        assert.deepStrictEqual(policy.status(), {
            lastMoveAt: 11000,
            moveReason: 'stall',
            moveCount: 1,
            failureStreak: 0
        });
    });
});
