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
 **********************************************************************/

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const ChangeDetector = require('../../../../src/ws/change_detector.js');
const EntityLookupReaders = require('../../../../src/db/readers/entities/lookups.js');
const BetReaders = require('../../../../src/db/readers/polls_bets/bets.js');
const { VALID_TYPES } = require('../../../../src/ws/channel_manager/channels.js');

async function collect(db, action) {
    const detector = new ChangeDetector({ db });
    const events = [];
    detector.on('lifecycle_event', (coin, event) => events.push(event));
    await detector.emitLifecycleEvents('BTC', { coin: 'BTC' }, action);
    return events;
}

describe('edit and cancel lifecycle routing', function () {
    afterEach(() => sinon.restore());

    for (const action of ['DISPENSER_CANCEL', 'DISPENSER_EDIT']) {
        it(`routes a valid ${action} to its parent dispenser`, async function () {
            const lookup = sinon.stub().resolves(41);
            const events = await collect({ getValidDispenserMutationIndex: lookup }, {
                action, action_index: 90, source: 'owner', status: null
            });

            expect(events).to.have.lengthOf(1);
            expect(events[0]).to.include({ type: action, action, channel: 'dispenser' });
            expect(events[0].data.dispenser_action_index).to.equal(41);
            expect(lookup.calledOnceWith({ coin: 'BTC' }, action, 90)).to.equal(true);
        });
    }

    it('routes a valid BET_EDIT to its parent feed with the format discriminator', async function () {
        const lookup = sinon.stub().resolves(52);
        const events = await collect({ getValidBetEditFeedIndex: lookup }, {
            action: 'BET_EDIT', action_index: 91, action_format: 4, status: null
        });

        expect(events).to.have.lengthOf(1);
        expect(events[0]).to.include({ type: 'BET_EDIT', action: 'BET_EDIT', channel: 'bet_feed' });
        expect(events[0].data.feed_action_index).to.equal(52);
        expect(events[0].data.action_format).to.equal(4);
        expect(lookup.calledOnceWith({ coin: 'BTC' }, 91)).to.equal(true);
    });

    for (const testCase of [
        { action: 'DISPENSER_CANCEL', method: 'getValidDispenserMutationIndex' },
        { action: 'DISPENSER_EDIT', method: 'getValidDispenserMutationIndex' },
        { action: 'BET_EDIT', method: 'getValidBetEditFeedIndex' }
    ]) {
        it(`does not route ${testCase.action} when no valid protocol row exists`, async function () {
            const db = { [testCase.method]: sinon.stub().resolves(null) };
            const events = await collect(db, {
                action: testCase.action, action_index: 92, action_format: 4,
                status: 'valid'
            });

            expect(events).to.deep.equal([]);
        });

        it(`fails closed when ${testCase.action} validity cannot be read`, async function () {
            const db = { [testCase.method]: sinon.stub().rejects(new Error('read failed')) };
            const events = await collect(db, { action: testCase.action, action_index: 93 });

            expect(events).to.deep.equal([]);
        });
    }

    it('keeps all routed action names admitted by the types filter', function () {
        const routed = ['BET_EDIT', 'DISPENSER_CANCEL', 'DISPENSER_EDIT'];

        expect(routed.filter((type) => !VALID_TYPES.has(type))).to.deep.equal([]);
        expect(routed.filter((type) => !ChangeDetector.LIFECYCLE_MAP[type])).to.deep.equal([]);
    });
});

describe('valid lifecycle parent lookups', function () {
    it('reads dispenser cancel and edit parents only through valid status rows', async function () {
        for (const [action, table] of [
            ['DISPENSER_CANCEL', 'dispenser_cancels'],
            ['DISPENSER_EDIT', 'dispenser_edits']
        ]) {
            let issued;
            const reader = {
                doQuery: async (config, sql, args) => {
                    issued = { config, sql, args };
                    return [{ dispenser_action_index: 71 }];
                }
            };
            const result = await EntityLookupReaders.getValidDispenserMutationIndex.call(
                reader, { coin: 'BTC' }, action, 101);

            expect(result).to.equal(71);
            expect(issued.config).to.deep.equal({ coin: 'BTC' });
            expect(issued.args).to.deep.equal([101]);
            expect(issued.sql).to.include(`${table} m`);
            expect(issued.sql).to.match(/INNER JOIN index_statuses s ON \(s\.id=m\.status_id\)/);
            expect(issued.sql).to.match(/s\.status='valid'/);
        }
    });

    it('refuses an unknown dispenser mutation without issuing dynamic SQL', async function () {
        const reader = { doQuery: sinon.spy() };
        const result = await EntityLookupReaders.getValidDispenserMutationIndex.call(
            reader, {}, 'DISPENSER_DROP_TABLE', 102);

        expect(result).to.equal(null);
        expect(reader.doQuery.called).to.equal(false);
    });

    it('reads a bet edit parent only through a valid status row', async function () {
        let issued;
        const reader = {
            doQuery: async (config, sql, args) => {
                issued = { config, sql, args };
                return [{ feed_action_index: 81 }];
            }
        };
        const result = await BetReaders.getValidBetEditFeedIndex.call(
            reader, { coin: 'BTC' }, 103);

        expect(result).to.equal(81);
        expect(issued.args).to.deep.equal([103]);
        expect(issued.sql).to.include('bet_edits m');
        expect(issued.sql).to.match(/INNER JOIN index_statuses s ON \(s\.id=m\.status_id\)/);
        expect(issued.sql).to.match(/s\.status='valid'/);
    });

    it('returns no parent when a validity-filtered lookup finds no row', async function () {
        const reader = { doQuery: sinon.stub().resolves([]) };

        expect(await EntityLookupReaders.getValidDispenserMutationIndex.call(
            reader, {}, 'DISPENSER_EDIT', 104)).to.equal(null);
        expect(await BetReaders.getValidBetEditFeedIndex.call(reader, {}, 105)).to.equal(null);
    });
});
