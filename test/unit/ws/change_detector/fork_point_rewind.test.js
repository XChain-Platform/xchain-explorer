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
 **********************************************************************
 * Unit tests for the fork-point rewind in src/ws/change_detector/coin.js
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const coinPass = require('../../../../src/ws/change_detector/coin.js');

function block(index, hash, actionCount = 0) {
    return { block_index: index, block_hash: hash, action_count: actionCount };
}

function action(actionIndex, blockIndex) {
    return { action_index: actionIndex, block_index: blockIndex };
}

function makeDetector(chain, actions) {
    const detector = Object.create(coinPass);
    detector.fetchLimit = 100;
    detector.emit = sinon.spy();
    detector.state = { BTC: { initialized: false } };
    detector.nextCursor = (rows, field, tip) =>
        rows && rows.length ? rows[rows.length - 1][field] : tip;
    detector.emitLifecycleEvents = async () => {};
    detector.emitEntityUpdates = async () => {};
    detector.emitAttestationEvents = async () => {};
    detector.checkBetLatches = async () => {};
    detector.checkXcallPhases = async () => {};
    detector.reorged = false;
    detector.db = {
        checkReorgAndInvalidate: async () => detector.reorged,
        getMaxBlockIndex: async () => chain.blocks[chain.blocks.length - 1].block_index,
        getMaxActionIndex: async () => BigInt(actions.rows[actions.rows.length - 1].action_index),
        getBlocksSince: async (config, since, limit) =>
            chain.blocks.filter((b) => b.block_index > since).slice(0, limit),
        getActionsSince: async (config, since, limit) =>
            actions.rows.filter((a) => BigInt(a.action_index) > BigInt(since)).slice(0, limit)
    };
    return detector;
}

describe('change detector fork-point rewind', function () {
    it('re-emits same-height blocks and actions first seen at initialization', async function () {
        const chain = { blocks: [block(10, 'a', 1), block(11, 'b', 1)] };
        const actions = { rows: [action(5n, 10), action(6n, 11)] };
        const detector = makeDetector(chain, actions);

        await detector.checkCoin('BTC');
        chain.blocks = [block(10, 'a', 1), block(11, 'b', 1), block(12, 'c', 1)];
        actions.rows = [action(5n, 10), action(6n, 11), action(7n, 12)];
        await detector.checkCoin('BTC');
        detector.emit.resetHistory();

        chain.blocks = [block(10, 'a', 1), block(11, 'b2', 1), block(12, 'c2', 1)];
        actions.rows = [action(5n, 10), action(6n, 11), action(7n, 12)];
        detector.reorged = true;
        await detector.checkCoin('BTC');

        const blocks = detector.emit.getCalls().filter((c) => c.args[0] === 'block').map((c) => c.args[2].block_hash);
        expect(blocks).to.deep.equal(['b2', 'c2']);
        const replayed = detector.emit.getCalls().filter((c) => c.args[0] === 'action').map((c) => c.args[2].action_index);
        expect(replayed).to.deep.equal([6n, 7n]);
    });

    it('rewinds only to the lowest replaced height', async function () {
        const chain = { blocks: [block(10, 'a'), block(11, 'b'), block(12, 'c')] };
        const actions = { rows: [action(5n, 10), action(6n, 12)] };
        const detector = makeDetector(chain, actions);
        detector.state.BTC = { initialized: true, blockIndex: 12, actionIndex: 6n, closedBlock: 12, xcallBlock: 12,
            history: new Map([
                [10, { hash: 'a', firstAction: 5n }],
                [11, { hash: 'b', firstAction: null }],
                [12, { hash: 'c', firstAction: 6n }]
            ]) };

        chain.blocks = [block(10, 'a'), block(11, 'b'), block(12, 'c2')];
        detector.reorged = true;
        await detector.checkCoin('BTC');

        expect(detector.state.BTC.blockIndex).to.equal(12);
        const emitted = detector.emit.getCalls().filter((c) => c.args[0] === 'block').map((c) => c.args[2].block_hash);
        expect(emitted).to.deep.equal(['c2']);
        const replayed = detector.emit.getCalls().filter((c) => c.args[0] === 'action').map((c) => c.args[2].action_index);
        expect(replayed).to.deep.equal([6n]);
    });

    it('still clamps to a lower tip when nothing is remembered', async function () {
        const chain = { blocks: [block(8, 'x')] };
        const actions = { rows: [action(3n, 8)] };
        const detector = makeDetector(chain, actions);
        detector.state.BTC = { initialized: true, blockIndex: 12, actionIndex: 9n, closedBlock: 12, xcallBlock: 12 };

        detector.reorged = true;
        await detector.checkCoin('BTC');

        expect(detector.state.BTC.blockIndex).to.equal(8);
        expect(detector.state.BTC.actionIndex).to.equal(3n);
    });
});
