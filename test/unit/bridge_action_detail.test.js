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
 * The XBRIDGE action-detail handler (src/action-detail/tokens.js), for the
 * bridge action page (xchain-bridge.md section 13, token spec section 9).
 *
 * WHY THE PENDING FLAG IS THE POINT. A bridge transfer's two legs are mined on
 * DIFFERENT chains and the explorer is per-coin routed, so the settle leg for a
 * BTC lock is applied on DOGE and this node holds no bridge_settlements row for
 * the lock, by construction and forever. A handler that reported "no settlement
 * row" the same way it reports a row it failed to read would tell a holder their
 * in-flight transfer had no record. `bridge_pending` is what separates the two,
 * and it is the one thing on this card a reader acts on.
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');

const { REGISTRY, ACTION_TYPES, getHandler } = require('../../src/action-detail');

// Minimal ctx: the handler reaches the pool through db.doQuery, so the double
// only has to answer that one call.
function ctx(rows) {
    const queries = [];
    return {
        queries,
        ctx: {
            action_index: 4242,
            config: { coin: 'DOGE' },
            db: { async doQuery(config, sql, args) { queries.push({ sql, args }); return rows; } }
        }
    };
}

describe('XBRIDGE action detail handler @regression', function () {

    it('is registered, so the action page is not a blank fall-through', function () {
        assert.ok(REGISTRY.XBRIDGE, 'no XBRIDGE handler: getActionData would de-blank and render nothing');
        assert.ok(ACTION_TYPES.includes('XBRIDGE'));
        assert.equal(getHandler('XBRIDGE'), REGISTRY.XBRIDGE);
    });

    it('runs no detail query of its own: the user legs have no wire table', function () {
        const built = REGISTRY.XBRIDGE.queries();
        assert.equal(built.query, null);
        assert.equal(built.query2, null);
        assert.equal(built.query3, null);
    });

    it('resolves an injected leg from bridge_settlements keyed on its OWN action_index', async function () {
        const row = { transfer_id: 'e'.repeat(64), kind: 'transfer', block_index: 77,
                      src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE',
                      dest_address: 'Ddest', tick: 'BTC.FUFU' };
        const h = ctx([row]);
        const data = { action_format: 5 };
        await REGISTRY.XBRIDGE.afterMain(h.ctx, data);
        assert.equal(h.queries.length, 1);
        assert.match(h.queries[0].sql, /FROM bridge_settlements/);
        assert.equal(h.queries[0].args[0], 4242, 'the settle row is keyed by the INJECTED leg own index');
        assert.equal(data.transfer_id, 'e'.repeat(64));
        assert.equal(data.bridge_kind, 'transfer');
        assert.equal(data.tick, 'BTC.FUFU');
        assert.equal(data.bridge_pending, false);
    });

    it('reports a user leg with no local settlement as PENDING, not as a blank', async function () {
        const h = ctx([]);
        const data = { action_format: 0 };
        await REGISTRY.XBRIDGE.afterMain(h.ctx, data);
        assert.equal(data.bridge_settlement, null);
        assert.equal(data.bridge_pending, true,
            'a lock settles on the OTHER chain; a null settlement here is in-flight, not missing');
        assert.equal(data.transfer_id, null);
    });

    it('keeps a tick the baseline already carried when no settlement row names one', async function () {
        const h = ctx([]);
        const data = { action_format: 3, tick: 'FUFU' };
        await REGISTRY.XBRIDGE.afterMain(h.ctx, data);
        assert.equal(data.tick, 'FUFU', 'the handler must not blank a field the baseline resolved');
    });

    it('carries the policy settle kind through, so a policy leg is not read as a transfer', async function () {
        const h = ctx([{ transfer_id: 'f'.repeat(64), kind: 'policy', block_index: 9,
                         src_chain: 'BTC', src_action_index: null, dest_chain: null,
                         dest_address: null, tick: 'BTC.FUFU' }]);
        const data = { action_format: 5 };
        await REGISTRY.XBRIDGE.afterMain(h.ctx, data);
        assert.equal(data.bridge_kind, 'policy');
    });
});
