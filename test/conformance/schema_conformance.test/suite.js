/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 */

'use strict';

const runtime = require('./runtime.js');
const reads = require('./reads.js');
const feeds = require('./feeds.js');
const fixture = require('./fixture_parity.js');

describe('Real-schema conformance canary (real DDL on real MariaDB)', function () {
    this.timeout(120000);
    before(runtime.setupConformance);
    after(runtime.teardownConformance);
    reads.registerRoutedReadPaths(runtime);
    reads.registerMirroredListRoutes(runtime);
    reads.registerDetailReads(runtime);
    feeds.registerWebSocketFeed(runtime);
    feeds.registerDecoderMempool(runtime);
    fixture.registerFixtureParity(runtime);
});
