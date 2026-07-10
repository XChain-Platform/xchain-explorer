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
 * Conformance test: the bundled browser WS client (src/content/js/xchain-ws.js)
 * hardcodes CLIENT_WS_SCHEMA_VERSION because it is a plain, un-bundled script
 * that cannot require() src/ws/schema-version.js's WS_SCHEMA_VERSION. This test
 * fails if the two values are ever allowed to drift, which would otherwise make
 * the first-party UI warn (or fail to warn) incorrectly against its own server.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { WS_SCHEMA_VERSION } = require('../../../src/ws/schema-version.js');

describe('xchain-ws.js CLIENT_WS_SCHEMA_VERSION conformance', function () {

    it('matches src/ws/schema-version.js WS_SCHEMA_VERSION', function () {
        const clientPath = path.join(__dirname, '../../../src/content/js/xchain-ws.js');
        const source      = fs.readFileSync(clientPath, 'utf8');
        const match       = source.match(/var\s+CLIENT_WS_SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
        expect(match, 'CLIENT_WS_SCHEMA_VERSION declaration not found in xchain-ws.js').to.not.equal(null);
        const clientVersion = Number(match[1]);
        expect(clientVersion).to.equal(WS_SCHEMA_VERSION);
    });

});
