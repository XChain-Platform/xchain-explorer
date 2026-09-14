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

const proxyquire  = require('proxyquire');

const Utility = require('../../../src/lib/utility.js');

const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig } = require('../../fixtures/mock-query-args.js');

// ─────────────────────────────────────────────────────────────────────────
// Database#getCapabilitySnapshots (real db/index.js SQL-generating method, mariadb
// stubbed out, no live connection) -- same rig as explorer.checkpoints.test.js's
// DatabaseReal / makeRealDb.
// ─────────────────────────────────────────────────────────────────────────

const DatabaseReal = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeRealDb(explorerOverrides = {}) {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util, ...explorerOverrides };
    return new DatabaseReal(mockExplorer);
}

// The mirror is chain-agnostic (capability_snapshots carries no chain/network
// columns -- see the existing getCapabilitySnapshotRows comment at db/index.js:7669-7672),
// so unlike getCheckpoints' HUB fixture, no chain/network filterParams are
// expected to be bound against this table. See the proposal's header note:
// this contradicts the seam contract's generic "filterParams come FIRST in
// your args array" guidance for mirror-backed rows, and the raw reader
// already proves it by binding only [capability, snapshotBlock].
const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function capSnapConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getCapabilitySnapshots',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

module.exports = { makeRealDb, HUB, capSnapConfig };
