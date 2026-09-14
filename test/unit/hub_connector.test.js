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

const core = require('./hub_connector.test/core.js');
const retryEndpoints = require('./hub_connector.test/retry_endpoints.js');
const configResults = require('./hub_connector.test/config_results.js');
const credentials = require('./hub_connector.test/credentials.js');

describe('XChainHubConnector', function () {
    for (const register of [...core, ...retryEndpoints, ...configResults, ...credentials]) register();
});
