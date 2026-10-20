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
 * MARKET_UPDATE trigger set against the indexer's market refresh. The indexer
 * rewrites a `markets` row after its order-family scan and after any action that
 * writes an order status row; every such action must push MARKET_UPDATE here.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { mk } = require('../change_detector_methods.test/support/helpers.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const INDEXER = siblingCheckout(__dirname, path.join('..', '..', '..', '..', '..', 'xchain-indexer'));

// Each indexer file that writes an order status row, and the action name its rows
// carry once settled (order/settle.js also writes the renamed ORDER_CANCEL row). A
// new writer fails below until it is classified here.
const ORDER_STATUS_WRITERS = {
    'coinpay/settle.js':          ['COINPAY'],
    'coinpay_expire.js':          ['COINPAY_EXPIRE'],
    'cross_settle/settle_leg.js': ['CROSS_SETTLE'],
    'order/settle.js':            ['ORDER', 'ORDER_CANCEL'],
    'order_expire/settle.js':     ['ORDER_EXPIRE'],
    'order_match/settle.js':      ['ORDER_MATCH'],
    'sweep/settle.js':            ['SWEEP']
};

// Every .js file under dir, as paths relative to it with forward slashes.
function jsFiles(dir, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...jsFiles(dir, next));
        else if (entry.name.endsWith('.js')) out.push(next);
    }
    return out;
}

// Whether one action, with one subscribed pair, pushes a MARKET_UPDATE.
async function pushesMarketUpdate(action) {
    const det = mk();
    det.channelManager.getSubscribedMarkets.returns([{ tick1: 'A', tick2: 'B' }]);
    det.db.getMarketInfo.resolves({ bid: '1', ask: '2' });
    const evs = [];
    det.on('entity_update', (c, e) => evs.push(e));
    await det.emitEntityUpdates('BTC', {}, { action, action_index: 1 });
    return evs.some((e) => e.type === 'MARKET_UPDATE');
}

describe('MARKET_UPDATE triggers against the indexer market refresh', function () {

    it('pushes on every action the indexer order scan counts', async function () {
        if (!skipOrFail(this, INDEXER, 'the market-refresh scan conformance guard')) return;
        const src = fs.readFileSync(path.join(INDEXER.path, 'src', 'db', 'markets', 'market_pairs.js'), 'utf8');
        const list = src.match(/a2\.action IN \(([^)]*)\)/);
        expect(list, 'market_pairs.js lost its `a2.action IN (...)` order scan').to.not.equal(null);
        const scanned = list[1].match(/'[A-Z_]+'/g).map((s) => s.slice(1, -1));
        expect(scanned.length, 'read no action names from the order scan').to.be.greaterThan(0);
        const missed = [];
        for (const action of scanned) if (!(await pushesMarketUpdate(action))) missed.push(action);
        expect(missed, 'scanned actions that push no MARKET_UPDATE').to.deep.equal([]);
    });

    it('pushes on every action whose settle writes an order status row', async function () {
        if (!skipOrFail(this, INDEXER, 'the order-status writer conformance guard')) return;
        const actionsDir = path.join(INDEXER.path, 'src', 'actions');
        const writers = jsFiles(actionsDir)
            .filter((rel) => fs.readFileSync(path.join(actionsDir, rel), 'utf8').includes('createOrderStatus('));
        expect(writers.length, 'found no createOrderStatus writer under src/actions').to.be.greaterThan(0);
        const unmapped = writers.filter((rel) => !ORDER_STATUS_WRITERS[rel]);
        expect(unmapped, 'order status writers with no action in ORDER_STATUS_WRITERS').to.deep.equal([]);
        const missed = [];
        for (const rel of writers) {
            for (const action of ORDER_STATUS_WRITERS[rel]) {
                if (!(await pushesMarketUpdate(action))) missed.push(action);
            }
        }
        expect(missed, 'order status writers that push no MARKET_UPDATE').to.deep.equal([]);
    });

    // An edit writes an order_edits row only: no status row and no scan entry.
    it('does not push on ORDER_EDIT, which changes no markets row', async function () {
        expect(await pushesMarketUpdate('ORDER_EDIT')).to.equal(false);
    });
});
