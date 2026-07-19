// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for docs/openapi.build.js: the generator that emits the
// explorer's public OpenAPI 3.1 spec. The script is a self-executing CLI (it
// writes docs/openapi.json on run and exports nothing), so it is exercised by
// running it in a child process and validating the artifact it produces. The
// committed docs/openapi.json is snapshotted and restored so the tree is left
// untouched, and re-running the generator must be deterministic (no diff).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const BUILD = path.join(REPO, 'docs', 'openapi.build.js');
const OUT = path.join(REPO, 'docs', 'openapi.json');

describe('docs/openapi.build.js', function () {
    let original = null;

    before(function () {
        original = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
    });

    after(function () {
        // Restore the exact committed bytes so the working tree stays clean.
        if (original !== null) fs.writeFileSync(OUT, original);
    });

    it('runs cleanly and generates a valid OpenAPI 3.1 document', function () {
        execFileSync(process.execPath, [BUILD], { stdio: 'pipe' });
        assert.ok(fs.existsSync(OUT), 'the generator must write docs/openapi.json');

        const spec = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        assert.strictEqual(spec.openapi, '3.1.0');
        assert.ok(spec.info && typeof spec.info.title === 'string' && spec.info.title.length > 0);
        assert.ok(spec.paths && typeof spec.paths === 'object');
        assert.ok(Object.keys(spec.paths).length > 0, 'at least one documented path');
    });

    it('templates every path over the {COIN} enum and gives each an operation', function () {
        execFileSync(process.execPath, [BUILD], { stdio: 'pipe' });
        const spec = JSON.parse(fs.readFileSync(OUT, 'utf8'));

        const coinEnum = spec.components.parameters.coin.schema.enum;
        assert.ok(coinEnum.includes('BTC') && coinEnum.includes('RBTC'), 'COIN enum covers mainnet + regtest prefixes');

        for (const [p, item] of Object.entries(spec.paths)) {
            assert.ok(p.startsWith('/{COIN}/'), `path ${p} is coin-templated`);
            const verbs = Object.keys(item).filter((k) => ['get', 'post', 'put', 'delete'].includes(k));
            assert.ok(verbs.length > 0, `path ${p} declares at least one HTTP operation`);
        }
    });

    it('is deterministic: two runs produce byte-identical output', function () {
        execFileSync(process.execPath, [BUILD], { stdio: 'pipe' });
        const first = fs.readFileSync(OUT);
        execFileSync(process.execPath, [BUILD], { stdio: 'pipe' });
        const second = fs.readFileSync(OUT);
        assert.ok(first.equals(second), 'the generator must be reproducible');
    });
});
