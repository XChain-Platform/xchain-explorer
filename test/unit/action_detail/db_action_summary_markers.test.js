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
 * The structure markers on the compact action summary. A multi-send is one
 * action with one sends[] row per leg and the summary flattens leg 0, so a
 * list row could not show that a send had four recipients; a BATCH parent
 * projected nothing and rendered as a bare name; a member's parent, derived
 * per history row, never reached the client. These pin the three markers
 * (leg_count, member_count, parent_batch_action_index) and that a single
 * send, a lone destroy and a field-less action keep their exact prior shape.
 */
'use strict';
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb() {
    return new Database(mockExplorer);
}

describe('action summary structure markers: projectActionSummary', function () {
    it('a multi-send carries leg_count beside its leg-0 fields', function () {
        const out = makeDb().projectActionSummary({
            action: 'SEND', source: 'addrA',
            sends: [
                { destination: 'addrB', tick: 'P00P', amount: '1', status: 'valid' },
                { destination: 'addrC', tick: 'P00P', amount: '2', status: 'valid' },
                { destination: 'addrD', tick: 'P00P', amount: '3', status: 'valid' },
                { destination: 'addrE', tick: 'P00P', amount: '4', status: 'valid' },
            ]
        });
        expect(out.details.leg_count).to.equal(4);
        expect(out.details).to.include({ destination: 'addrB', tick: 'P00P', amount: '1' });
        expect(out.status).to.equal('valid');
    });

    it('a single send has no leg_count value, not 1', function () {
        const out = makeDb().projectActionSummary({
            action: 'SEND', source: 'addrA',
            sends: [{ destination: 'addrB', tick: 'P00P', amount: '1', status: 'valid' }]
        });
        // The SEND projection copies every whitelisted name off sends[0], so the
        // key exists holding undefined, which JSON drops: the wire row is unchanged.
        expect(out.details.leg_count).to.equal(undefined);
        expect(JSON.parse(JSON.stringify(out.details))).to.not.have.property('leg_count');
    });

    it('a multi-destroy carries leg_count from destroys[]', function () {
        const out = makeDb().projectActionSummary({
            action: 'DESTROY', status: 'valid', tick: 'P00P', amount: '1',
            destroys: [{ tick: 'P00P', amount: '1', status: 'valid' }, { tick: 'P00P', amount: '2', status: 'valid' }]
        });
        expect(out.details.leg_count).to.equal(2);
        expect(out.details.tick).to.equal('P00P');
    });

    it('a lone destroy has no leg_count', function () {
        const out = makeDb().projectActionSummary({
            action: 'DESTROY', status: 'valid', tick: 'P00P', amount: '1',
            destroys: [{ tick: 'P00P', amount: '1', status: 'valid' }]
        });
        expect(out.details).to.not.have.property('leg_count');
    });

    it('a BATCH parent carries member_count even though it projects no other field', function () {
        const out = makeDb().projectActionSummary({
            action: 'BATCH', status: 'valid',
            actions: [{ action: 'SEND' }, { action: 'ISSUE' }, { action: 'MINT' }]
        });
        expect(out.details).to.deep.equal({ member_count: 3 });
    });

});

describe('action summary structure markers: the prior shape', function () {
    it('a field-less action still projects details false', function () {
        const out = makeDb().projectActionSummary({ action: 'ANCHOR', status: 'valid' });
        expect(out.details).to.equal(false);
    });

    it('the three marker names are in ACTION_SUMMARY_FIELDS, so the renderer contract knows them', function () {
        for (const name of ['leg_count', 'member_count', 'parent_batch_action_index'])
            expect(Database.ACTION_SUMMARY_FIELDS, name).to.include(name);
    });
});

describe('action summary structure markers: getActionSummaryData member rows', function () {
    function summarize(actionData, rows) {
        const db = makeDb();
        db.getActionDataBatch = async () => new Map(Object.entries(actionData).map(([k, v]) => [Number(k), v]));
        return db.getActionSummaryData({}, rows);
    }

    it('a history row with a derived BATCH parent carries it inside details', async function () {
        const rows = await summarize(
            { 42: { action: 'SEND', sends: [{ destination: 'addrB', tick: 'P00P', amount: '1', status: 'valid' }] } },
            [{ action_index: 42, action: 'SEND', parent_batch_action_index: '41' }]
        );
        expect(rows[0].details.parent_batch_action_index).to.equal(41);
        expect(rows[0].details.destination).to.equal('addrB');
    });

    it('a member with no summary field still gets a details object for the mark', async function () {
        const rows = await summarize(
            { 43: { action: 'ANCHOR', status: 'valid' } },
            [{ action_index: 43, action: 'ANCHOR', parent_batch_action_index: 41 }]
        );
        expect(rows[0].details).to.deep.equal({ parent_batch_action_index: 41 });
    });

    it('a row with a null parent keeps details false, the shape every other list relies on', async function () {
        const rows = await summarize(
            { 44: { action: 'ANCHOR', status: 'valid' } },
            [{ action_index: 44, action: 'ANCHOR', parent_batch_action_index: null }]
        );
        expect(rows[0].details).to.equal(false);
    });

    it('a transaction row that never derived a parent is untouched', async function () {
        const rows = await summarize(
            { 45: { action: 'ANCHOR', status: 'valid' } },
            [{ action_index: 45, action: 'ANCHOR' }]
        );
        expect(rows[0].details).to.equal(false);
    });
});
