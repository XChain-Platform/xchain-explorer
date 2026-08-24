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

// Boot-time consensus-pin verification for the explorer, mirroring the hub,
// indexer, decoder and utxo-tracker. startApi() must call
// coins.verifyConsensusPin() for every network BEFORE the hub config fetch, the
// DB pool and the proof server, so a coin bundle that drifted on the running
// host halts instead of answering proof-liveness questions and serving
// burn/gas/protocol addresses out of an unverified registry. CI hashes the
// checkout; only this check sees the artifact actually running.
//
// src/api.js boots on require (it calls startApi() at module scope, with no
// require.main guard), so the fail-closed behaviour is exercised in a CHILD
// process rather than by requiring api.js into the suite.

const assert       = require('assert');
const fs           = require('fs');
const path         = require('path');
const { spawnSync } = require('child_process');

const coins    = require('../../src/coins');
const REPO     = path.join(__dirname, '..', '..');
const API_PATH = path.join(REPO, 'src', 'api.js');

function startApiBody(){
    const src = fs.readFileSync(API_PATH, 'utf8');
    const at  = src.indexOf('async function startApi()');
    assert.ok(at > -1, 'src/api.js no longer declares startApi()');
    return src.slice(at);
}

describe('explorer boot consensus-pin verification', function(){

    it('the pin check runs before the hub config fetch and the express app', function(){
        // Source-order guard, scoped to startApi's body because textual order over
        // the whole file is not execution order. It must not be reorderable behind
        // the config fetch (a network call) or the HTTP surface.
        const body   = startApiBody();
        const pinAt  = body.indexOf('coins.verifyConsensusPin(net)');
        const cfgAt  = body.indexOf('configInfo.getConfig(');
        const appAt  = body.indexOf('const app = express()');
        assert.ok(pinAt > -1, 'startApi() does not call coins.verifyConsensusPin');
        assert.ok(cfgAt > -1, 'startApi() no longer fetches hub config; re-anchor this guard');
        assert.ok(appAt > -1, 'startApi() no longer builds the express app; re-anchor this guard');
        assert.ok(pinAt < cfgAt, 'the pin check must precede the hub config fetch');
        assert.ok(pinAt < appAt, 'the pin check must precede express()');
    });

    it('passes on the vendored bundle for every network', function(){
        for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);
    });

    it('skips on the (currently null) mainnet pin', function(){
        assert.deepStrictEqual(coins.verifyConsensusPin('mainnet'), { ok: true, skipped: true });
    });

    it('halts the process fail-closed when the pin does not verify', function(){
        // Preconditioned on the source guard so a REMOVED check fails here rather
        // than letting the child boot a real explorer (hub fetch, DB pool, ports).
        assert.ok(startApiBody().indexOf('coins.verifyConsensusPin(net)') > -1,
            'startApi() does not call coins.verifyConsensusPin; refusing to boot a child');

        // The child replaces the verifier with a thrower before requiring api.js,
        // so nothing on disk changes and no port is ever reached.
        const child = spawnSync(process.execPath, ['-e', [
            "const coins = require('./src/coins');",
            "coins.verifyConsensusPin = () => { throw new Error('CONSENSUS CONFIG PIN MISMATCH (boot test)'); };",
            "require('./src/api.js');"
        ].join('\n')], { cwd: REPO, encoding: 'utf8', timeout: 30000 });

        assert.strictEqual(child.status, 1, 'a pin mismatch must exit the process non-zero');
        assert.match(child.stderr || '', /CONSENSUS CONFIG PIN MISMATCH \(boot test\)/);
        assert.doesNotMatch(child.stdout || '', /listening|Listening/,
            'the process must halt before it announces a listener');
    });
});
