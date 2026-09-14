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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon } = require('./helpers.js');

const ENV_KEYS = ['EXPLORER_TIP_MAX_AGE_S', 'EXPLORER_TIP_MAX_AGE_S_RBTC',
                  'EXPLORER_TIP_MAX_FUTURE_SKEW_S', 'EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC',
                  'EXPLORER_STALE_FAIL_CLOSED'];

function clearTipEnvironment() {
    const savedEnv = {};
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    return savedEnv;
}

function restoreTipEnvironment(savedEnv) {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
}


// Returns a pool whose every query answers with this block_time.
function configurePool(db, coin, blockTime) {
    db.pools = {};
    db.pools[coin] = {
        pool: {
            getConnection: sinon.stub().resolves({
                query:   sinon.stub().resolves([{ max_index: 850, block_time: blockTime }]),
                release: sinon.stub().resolves()
            })
        },
        config: {}
    };
}

module.exports = { clearTipEnvironment, restoreTipEnvironment, configurePool };
