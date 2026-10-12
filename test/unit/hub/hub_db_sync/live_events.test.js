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
const proxyquire = require('proxyquire').noCallThru();
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version.js');
const { PENDING_PRICE_EVENT_CAP } = require('../../../../src/hub/hub_db_sync/mirror_bounds.js');

const mirrorWrites = [];
const loggedErrors = [];
const liveEvents = proxyquire('../../../../src/hub/hub_db_sync/live_events.js', {
    '../../observability/index.js': {
        getLogger: () => ({
            error: (...args) => loggedErrors.push(args),
            warn: () => {}
        })
    },
    './mirror_write.js': {
        applyMirrorWrite: async (...args) => mirrorWrites.push(args)
    }
});

function eventContext(overrides = {}) {
    return Object.assign({
        hubDb: {},
        _pendingPriceEvents: [],
        _pendingPriceOverflow: false,
        applyMatchAnchorStamp: liveEvents.applyMatchAnchorStamp,
        bufferPriceEvent: liveEvents.bufferPriceEvent
    }, overrides);
}

beforeEach(function () {
    mirrorWrites.length = 0;
    loggedErrors.length = 0;
});

describe('hub DB sync live row events', function () {
    it('applies a cross-chain match anchor event through the mirror writer', async function () {
        const context = eventContext();
        const event = {
            type: 'row:anchor-stamped',
            table: 'cross_chain_matches',
            schema_version: HUB_SCHEMA_VERSION,
            match_id: 'match-1',
            anchor_txid: 'anchor-1'
        };

        await liveEvents.handleRowEvent.call(context, event);

        assert.strictEqual(mirrorWrites.length, 1);
        assert.strictEqual(mirrorWrites[0][0], context.hubDb);
        assert.match(mirrorWrites[0][1], /^UPDATE cross_chain_matches SET anchor_txid/);
        assert.deepStrictEqual(mirrorWrites[0][2], ['anchor-1', 'match-1']);
    });

    it('refuses an event from a different hub schema version', async function () {
        const context = eventContext();
        const event = {
            type: 'row:anchor-stamped',
            table: 'cross_chain_matches',
            schema_version: HUB_SCHEMA_VERSION + 1,
            match_id: 'match-2',
            anchor_txid: 'anchor-2'
        };

        await liveEvents.handleRowEvent.call(context, event);

        assert.strictEqual(context._schemaMismatchSeen, true);
        assert.strictEqual(mirrorWrites.length, 0);
        assert.strictEqual(loggedErrors.length, 1);
    });
});

describe('hub DB sync pending price events', function () {
    it('stops at the cap and forces a failed flush', async function () {
        const pending = Array.from({ length: PENDING_PRICE_EVENT_CAP }, (_, index) => ({ index }));
        const context = eventContext({ _pendingPriceEvents: pending });

        liveEvents.bufferPriceEvent.call(context, { index: PENDING_PRICE_EVENT_CAP });
        liveEvents.bufferPriceEvent.call(context, { index: PENDING_PRICE_EVENT_CAP + 1 });

        assert.strictEqual(context._pendingPriceOverflow, true);
        assert.deepStrictEqual(context._pendingPriceEvents, []);
        assert.strictEqual(loggedErrors.length, 1);
        assert.strictEqual(await liveEvents.flushPendingPriceEvents.call(context), false);
        assert.strictEqual(context._pendingPriceOverflow, false);
    });
});
