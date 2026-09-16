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
 * Unit tests for ChannelManager (src/ws/channel_manager.js)
 */

'use strict';

const { expect } = require('chai');
const ChannelManager = require('../../../../../src/ws/channel_manager.js');

// Helper: create a mock client object
function createClient(id, coin) {
    return {
        id:            id || 1,
        coin:          coin || 'BTC',
        chain:         'BTC',
        network:       'mainnet',
        subscriptions: new Set()
    };
}

module.exports = { expect, ChannelManager, createClient };

