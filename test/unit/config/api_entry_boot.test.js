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

// src/api.js starts the service when it is the entry script or is required
// from node -e, and must stay inert when an ESM entry loads it. Test runners
// such as mocha 12 are ESM entries, so require.main is undefined there; a
// start condition keyed on that alone boots a real explorer (hub config fetch,
// listeners, pool setup) inside any suite that requires api.js.
//
// Each case runs in a child whose consensus-pin verifier is replaced by a
// thrower, so a boot exits 1 with the marker before any network or port.

const assert        = require('assert');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { spawnSync } = require('child_process');

const REPO     = path.join(__dirname, '..', '..', '..');
const API_PATH = path.join(REPO, 'src', 'api.js');
const MARKER   = 'API ENTRY BOOT MARKER';

// CommonJS body that arms the marker, then requires api.js and exits 0 if
// nothing booted within the window a boot needs to reach process.exit(1).
function loaderBody(){
    return [
        'const coins = require(' + JSON.stringify(path.join(REPO, 'src', 'coins')) + ');',
        "coins.verifyConsensusPin = () => { throw new Error('" + MARKER + "'); };",
        'require(' + JSON.stringify(API_PATH) + ');',
        'setTimeout(() => process.exit(0), 500);'
    ].join('\n');
}

function runChild(args){
    const res = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

describe('explorer api.js start condition', function(){
    this.timeout(45000);

    it('starts the service when required from node -e', function(){
        const res = runChild(['-e', loaderBody()]);
        assert.strictEqual(res.status, 1, 'node -e must still boot the explorer:\n' + res.output);
        assert.ok(res.output.includes(MARKER), 'the boot did not reach the pin check:\n' + res.output);
    });

    it('stays inert when an ESM entry such as a test runner requires it', function(){
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-api-entry-'));
        const loader = path.join(dir, 'loader.cjs');
        const entry  = path.join(dir, 'entry.mjs');
        fs.writeFileSync(loader, loaderBody());
        fs.writeFileSync(entry, [
            "import { createRequire } from 'module';",
            'createRequire(import.meta.url)(' + JSON.stringify(loader) + ');'
        ].join('\n'));
        const res = runChild([entry]);
        assert.ok(!res.output.includes(MARKER), 'an ESM entry booted the explorer:\n' + res.output);
        assert.strictEqual(res.status, 0, 'the ESM child did not exit cleanly:\n' + res.output);
    });
});
