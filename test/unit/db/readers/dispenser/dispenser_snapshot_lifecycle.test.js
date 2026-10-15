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
 * One dispenser reads the same on the live feed and on /dispensers.
 *
 * getDispenserInfo backs the WebSocket dispenser SNAPSHOT and DISPENSER_UPDATE.
 * Its `status` is the dispenser's lifecycle (open, cancelled, expired, empty),
 * the same value /dispensers serves as current_status, never the CREATE
 * action's validity ('valid'), and a terminal dispenser reports 0 remaining,
 * as the REST list does.
 *
 * The REST list (dispenserPass) treats a drained dispenser's 'empty' as
 * terminal: the indexer refunds the residue that can no longer pay a whole
 * GIVE_AMOUNT, so create - payouts can leave dust the dispenser no longer holds.
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { dispenserPass }        = require('../../../../../src/db/query_sql/data_post.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function cfg(){ return makeConfig({ coin: 'BTC' }); }

// Dispenser 48 escrowed 1 and paid out 0.66666666 + 0.33333333, leaving 0.00000001.
function makeDb({ lifecycle }){
    const db = new Database({ configInfo, util });
    sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
        if(/FROM\s+dispenser_statuses/i.test(q))
            return lifecycle.map((status, i) => ({ dispenser_action_index: 48, action_index: 48 + i, status }));
        if(/FROM\s+dispenser_edits/i.test(q)) return [];
        if(/FROM\s+dispenses/i.test(q))
            return [{ dispenser_action_index: 48, give_amount: '0.66666666' },
                    { dispenser_action_index: 48, give_amount: '0.33333333' }];
        if(/a2\.address as source/i.test(q))
            return [{ action_index: 48, source: 'mkF8', give_tick: 'EIGHT', give_amount: '0.33333333',
                      give_escrow: '1', get_tick: null, get_amount: '0.0002', expiration: 0, status: 'valid' }];
        if(/FROM\s+dispensers/i.test(q)) return [{ action_index: 48, give_escrow: '1' }];
        return [];
    });
    return db;
}

describe('the WebSocket dispenser snapshot reports the lifecycle', function () {
    afterEach(() => sinon.restore());

    it('an open dispenser reports open, not the create validity', async () => {
        const info = await makeDb({ lifecycle: ['open'] }).getDispenserInfo(cfg(), 48);
        expect(info.status).to.equal('open');
        expect(info.give_remaining).to.equal('0.00000001');
    });

    for (const terminal of ['cancelled', 'expired', 'empty']) {
        it('a ' + terminal + ' dispenser reports ' + terminal + ' and 0 remaining', async () => {
            const info = await makeDb({ lifecycle: ['open', terminal] }).getDispenserInfo(cfg(), 48);
            expect(info.status).to.equal(terminal);
            expect(info.give_remaining).to.equal('0');
        });
    }

    it('a cancelling dispenser keeps its escrow', async () => {
        const info = await makeDb({ lifecycle: ['open', 'cancelling'] }).getDispenserInfo(cfg(), 48);
        expect(info.status).to.equal('cancelling');
        expect(info.give_remaining).to.equal('0.00000001');
    });

    it('a create with no lifecycle row keeps its validity as the status', async () => {
        const info = await makeDb({ lifecycle: [] }).getDispenserInfo(cfg(), 48);
        expect(info.status).to.equal('valid');
    });

    it('agrees with the /dispensers row for the same dispenser', async () => {
        for (const lifecycle of [['open'], ['open', 'cancelled'], ['open', 'empty']]) {
            const db   = makeDb({ lifecycle });
            const info = await db.getDispenserInfo(cfg(), 48);
            const rows = [{ action_index: 48 }];
            await dispenserPass(db, cfg(), rows);
            expect(info.status, lifecycle.join('>')).to.equal(rows[0].current_status);
            expect(info.give_remaining, lifecycle.join('>')).to.equal(rows[0].escrow_remaining);
            sinon.restore();
        }
    });
});

describe('/dispensers treats a drained dispenser as terminal', function () {
    afterEach(() => sinon.restore());

    it('an empty dispenser lists 0 escrow_remaining, not the refunded dust', async () => {
        const db   = makeDb({ lifecycle: ['open', 'empty'] });
        const rows = [{ action_index: 48 }];
        await dispenserPass(db, cfg(), rows);
        expect(rows[0].current_status).to.equal('empty');
        expect(rows[0].escrow_remaining).to.equal('0');
    });
});
