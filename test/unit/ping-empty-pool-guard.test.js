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
 * The JSON-RPC `ping` probe guarded its SELECT 1 behind
 * `if(coin)` and then returned status:'success'/db:true unconditionally, so
 * an empty connection-pool map (a cold start before explorer.init() finishes,
 * or a recreated container that cannot reach the hub for config) reported a
 * node with zero usable databases as healthy.
 *
 * src/api.js calls startApi() at module scope, so requiring it boots the
 * server and the handler closure is unreachable from a test. The guard is
 * therefore asserted at the source level, the same wiring-guard pattern
 * xchain-utxo-tracker uses for its own in-closure health method.
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

describe('explorer ping empty-pool guard', function () {

    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const handler = src.slice(src.indexOf('async ping(params, {res})'),
                              src.indexOf('const httpServer = http.createServer(app)'));

    it('reads the first available pool key', function () {
        expect(handler).to.match(/const coin\s+= Object\.keys\(pools\)\[0\];/);
    });

    it('returns degraded rather than skipping the check when no pool exists', function () {
        expect(handler).to.match(/if\(!coin\)\{[\s\S]{0,200}res\.status\(503\);[\s\S]{0,200}status: 'degraded', db: false/);
    });

    it('no longer guards the SELECT 1 behind a truthy-coin branch', function () {
        // `if(coin){ ...SELECT 1... }` was the exact shape that let an empty pool
        // set fall through to the success return; the probe must always run the
        // query once it is past the guard above.
        expect(handler).to.not.match(/if\(coin\)\{/);
        expect(handler).to.match(/await Promise\.race\(\[[\s\S]{0,200}'SELECT 1'/);
    });

    it('reaches status:success only after the query resolves', function () {
        const guardIdx   = handler.indexOf('if(!coin)');
        const queryIdx   = handler.indexOf("'SELECT 1'");
        const successIdx = handler.indexOf("status: 'success', db: true");
        expect(guardIdx).to.be.greaterThan(-1);
        expect(queryIdx).to.be.greaterThan(guardIdx);
        expect(successIdx).to.be.greaterThan(queryIdx);
    });

});
