'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The any-coin address LIST item flag /api/status publishes per coin, read from
// the TOKEN_POLICY_INHERITANCE_ACTIVATION registry row at the coin's tip.

const { expect } = require('chai');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const { TOKEN_POLICY_INHERITANCE_KEY, listAnyCoinItemsAtTip } = require('../../../../src/db/readers/entities/list_item_gates.js');
const statusMethods = require('../../../../src/db/readers/entities/status.js');

const CONFIG = Object.freeze({
    COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' },
    COIN_NETWORKS: { BTC: {}, LTC: {}, DOGE: {} },
});

describe('list_item_gates: any-coin address LIST items at the tip', function () {
    const table = gateRegistry.get(TOKEN_POLICY_INHERITANCE_KEY);
    const btcTestnet = table['BTC:testnet'];

    it('reads true on regtest from genesis', function () {
        expect(table.regtest).to.equal(0);
        expect(listAnyCoinItemsAtTip(CONFIG, 'RBTC', 0)).to.equal(true);
        expect(listAnyCoinItemsAtTip(CONFIG, 'RDOGE', 500)).to.equal(true);
    });

    it('flips at the per-coin testnet height and not before', function () {
        expect(Number.isInteger(btcTestnet)).to.equal(true);
        expect(listAnyCoinItemsAtTip(CONFIG, 'TBTC', btcTestnet - 1)).to.equal(false);
        expect(listAnyCoinItemsAtTip(CONFIG, 'TBTC', btcTestnet)).to.equal(true);
    });

    it('reads false on mainnet, where the row is unarmed', function () {
        expect(listAnyCoinItemsAtTip(CONFIG, 'BTC', 900000)).to.equal(false);
    });

    it('reads false for an unknown tip or a route code naming no configured coin', function () {
        expect(listAnyCoinItemsAtTip(CONFIG, 'RBTC', null)).to.equal(false);
        expect(listAnyCoinItemsAtTip(CONFIG, 'RXYZ', 10)).to.equal(false);
        expect(listAnyCoinItemsAtTip({}, 'RBTC', 10)).to.equal(false);
    });
});

describe('list_item_gates: the flag in the /api/status report', function () {
    function fakeDb(tip) {
        const db = Object.create(statusMethods);
        db.configInfo = { getConfig: async () => ({ ...CONFIG, COIN_SUPPORTED: { RBTC: 1, BTC: 1 },
            COIN_AVAILABLE: { RBTC: 1, BTC: 1 } }) };
        db.pools = { RBTC: { pool: {} }, BTC: { pool: {} } };
        db.getMaxBlockIndex = async () => tip;
        db.getMaxBlockTime = async () => Math.floor(Date.now() / 1000);
        db.getDecoderTip = async () => tip;
        db.getIndexerState = async () => null;
        db.getReplicaHaltStatus = async () => false;
        db.isTipStale = () => false;
        return db;
    }

    it('publishes list_any_coin_items per measured coin', async function () {
        const [data] = await fakeDb(120).getStatus({});
        expect(data.list_any_coin_items).to.deep.equal({ RBTC: true, BTC: false });
    });
});
