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
 * A dispenser edit must say how much escrow it added, since that is what makes
 * the edit a REFILL. A dispenser may be refilled at most 5 times (see
 * xchain-indexer actions/dispenser.js, MAX_REFILLS); `getDispenserEdits`
 * previously omitted `give_escrow`, so no client could count refills against
 * that cap, and the wallet let an owner sign a sixth refill that the chain
 * always rejects. Reproduced on regtest: the column already existed on the
 * table, only the projection omitted it.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

function makeDb(rows = []){
    const db = new Database(mockExplorer);
    const seen = [];
    db.doQuery = async (config, query, args) => { seen.push({ query, args }); return rows; };
    return { db, seen };
}

const CONFIG = {
    coin: 'RLTC',
    data: { sql: { where: { data: '1=1', offset: '' }, order: 'DESC', limit: '10' } },
};

describe('a dispenser edit carries the escrow it added', () => {

    it('[REGRESSION] getDispenserEdits selects give_escrow', async () => {
        const { db } = makeDb();
        const [query] = await db.getDispenserEdits(CONFIG);
        expect(query, 'without the refill amount an edit cannot be told from an expiration '
            + 'change, so no client can count refills against the MAX_REFILLS cap')
            .to.match(/m\.give_escrow/);
    });

    it('still selects the fields the timeline already renders', async () => {
        // The point of the change is one added column, not a reshaped row: the
        // lifecycle timeline reads these, and dropping one would break a
        // surface that has nothing to do with refills.
        const { db } = makeDb();
        const [query] = await db.getDispenserEdits(CONFIG);
        for (const field of ['m.expiration', 'm.allow_list', 'm.block_list',
            'm.dispenser_action_index', 's1.status']) {
            expect(query, `getDispenserEdits stopped serving ${field}`).to.include(field);
        }
    });

    it('leaves the count query alone', async () => {
        // The total is a COUNT(*) over the same joins; adding a projected column
        // to it would be meaningless and is the kind of copy-paste this pins.
        const { db } = makeDb();
        const [, , count] = await db.getDispenserEdits(CONFIG);
        expect(count).to.match(/count\(\*\)/i);
        expect(count, 'the count query does not project rows').to.not.match(/m\.give_escrow/);
    });
});
