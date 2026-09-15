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

const { srcText } = require('../../../helpers/source_text');

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const healthReaders = require('../../../../src/db/readers/health.js');

describe('explorer ping empty-pool guard', function () {

    const src = srcText('src/api.js');
    const handler = src.slice(src.indexOf('async ping(params, {res})'),
                              src.indexOf('const httpServer = http.createServer(app)'));
    // The SELECT 1 itself lives in the pingPool Database method, so its body is read
    // from the health tip part here and the method is also called against a stub below.
    const healthSrc = fs.readFileSync(path.join(__dirname, '../../../../src/db/readers/health/tip.js'), 'utf8');
    const pingStart = healthSrc.indexOf('async pingPool(config)');
    const pingBody  = healthSrc.slice(pingStart, healthSrc.indexOf('\n    }\n', pingStart));
    const PING_CALL = 'db.pingPool({ coin, data: {} })';

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
        expect(handler).to.match(/await Promise\.race\(\[[\s\S]{0,200}db\.pingPool\(\{ coin, data: \{\} \}\)/);
        // Nor may the method reintroduce that branch, or return before the query runs.
        expect(pingStart).to.be.greaterThan(-1);
        expect(pingBody).to.match(/`SELECT 1`/);
        expect(pingBody).to.not.match(/\bif\s*\(|\breturn\b(?!\s+await this\.doQuery\(config, query, \[\]\);)/);
    });

    it('reaches status:success only after the query resolves', async function () {
        const guardIdx   = handler.indexOf('if(!coin)');
        const queryIdx   = handler.indexOf(PING_CALL);
        const successIdx = handler.indexOf("status: 'success', db: true");
        expect(guardIdx).to.be.greaterThan(-1);
        expect(queryIdx).to.be.greaterThan(guardIdx);
        expect(successIdx).to.be.greaterThan(queryIdx);

        // Called for real: the ping must send SELECT 1 to the pool it was handed and
        // resolve only with what the pool answered, never short-circuit to success.
        const calls = [];
        const up    = { doQuery: async (...args) => { calls.push(args); return [{ 1: 1 }]; } };
        const cfg   = { coin: 'BTC', data: {} };
        expect(await healthReaders.pingPool.call(up, cfg)).to.deep.equal([{ 1: 1 }]);
        expect(calls).to.deep.equal([[cfg, 'SELECT 1', []]]);

        // A pool failure must reach the handler's catch (the degraded 503), not be swallowed.
        const down = { doQuery: async () => { throw new Error('pool unreachable'); } };
        let failure = null;
        await healthReaders.pingPool.call(down, cfg).catch((e) => { failure = e; });
        expect(failure && failure.message).to.equal('pool unreachable');
    });

});
