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
 * Hash-only block identity reader used by the WebSocket reorg check.
 */

'use strict';

const { sinon, expect, makeDb, cfg } = require('./helpers.js');

describe('Database#getBlockHashesSince', function () {
    afterEach(function () { sinon.restore(); });

    it('binds the cursor and limit to the ledger-hash identity query', async function () {
        const db = makeDb();
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (_config, sql, args) => {
            captured = { sql: String(sql), args };
            return [{ block_index: 11, block_hash: 'abc' }];
        });
        const rows = await db.getBlockHashesSince(cfg(), 10, 2);
        expect(captured.args).to.deep.equal([10, 2]);
        expect(captured.sql).to.include('t1.id=b1.ledger_hash_id');
        expect(captured.sql).to.include('b1.block_index > ?');
        expect(rows).to.deep.equal([{ block_index: 11, block_hash: 'abc' }]);
    });

    it('returns an empty array when the query has no result set', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves(false);
        expect(await db.getBlockHashesSince(cfg(), 10, 2)).to.deep.equal([]);
    });
});
