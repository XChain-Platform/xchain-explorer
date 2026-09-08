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
 * Security tests: Rate limit drop-in pins
 *
 * deploy/rate-limits.conf pins all eight limiter env vars so a deployment's
 * behaviour never depends on which explorer build happens to be installed
 * (see the file's own header). That guarantee only holds while the pinned
 * set and the source's read set are the same eight names with the same
 * values: a knob added to the source without a pin would run at whatever
 * default ships next, and a default that moves without the drop-in
 * following would change behaviour on a restart nobody associates with a
 * limit change. Both failures are silent at review time, so this file
 * parses both sides and asserts they agree, in both directions.
 *
 * The parse-and-compare helpers take plain strings, not file paths, so the
 * falsification suite below can feed them fixture text and prove the
 * comparison actually names a missing pin, an orphaned pin and a value
 * drift, rather than merely existing.
 *
 * Run: mocha test/security/rate-limit-pins.test.js --timeout 5000 --exit
 */

'use strict';

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const CONF_PATH = path.join(__dirname, '../../deploy/rate-limits.conf');
const SRC_DIR   = path.join(__dirname, '../../src');

// One pin per `Environment=NAME=VALUE` line; NAME is whatever the drop-in
// names, not filtered to a naming convention, so a rename shows up as an
// orphan/unpinned pair instead of vanishing from both sides.
function parsePinnedLimits(confText) {
    const pins = new Map();
    const re = /^Environment=([A-Za-z0-9_]+_RATE_LIMIT_RPM)=(\d+)\s*$/gm;
    let m;
    while ((m = re.exec(confText)) !== null)
        pins.set(m[1], parseInt(m[2], 10));
    return pins;
}

// One default per `parseInt(process.env.NAME, 10) || N` read, the exact
// shape every limiter in api.js and XChainExplorer.js uses today.
function parseSourceLimits(sourceText) {
    const defaults = new Map();
    const re = /parseInt\(process\.env\.([A-Za-z0-9_]+_RATE_LIMIT_RPM),\s*10\)\s*\|\|\s*(\d+)/g;
    let m;
    while ((m = re.exec(sourceText)) !== null)
        defaults.set(m[1], parseInt(m[2], 10));
    return defaults;
}

// Named mismatch report: which knob is unpinned, which pin is orphaned, and
// which name's default disagrees with its pinned value (with both numbers),
// so a failure points straight at the offending variable instead of a bare
// "sets differ".
function comparePinsToSource(pins, sourceDefaults) {
    const unpinned = [...sourceDefaults.keys()].filter((n) => !pins.has(n));
    const orphaned = [...pins.keys()].filter((n) => !sourceDefaults.has(n));
    const drifted  = [];
    for (const [name, defaultValue] of sourceDefaults) {
        if (pins.has(name) && pins.get(name) !== defaultValue)
            drifted.push({ name, defaultValue, pinnedValue: pins.get(name) });
    }
    return { unpinned, orphaned, drifted };
}

function collectJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...collectJsFiles(full));
        else if (entry.name.endsWith('.js'))
            out.push(full);
    }
    return out;
}

describe('Security: Rate Limiting: pinned drop-in matches source defaults (rows 32, 33)', function () {

    const pins = parsePinnedLimits(fs.readFileSync(CONF_PATH, 'utf8'));

    const sourceDefaults = new Map();
    for (const file of collectJsFiles(SRC_DIR)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const [name, value] of parseSourceLimits(text))
            sourceDefaults.set(name, value);
    }

    const { unpinned, orphaned, drifted } = comparePinsToSource(pins, sourceDefaults);

    it('sees eight limiter env vars on each side today (sanity: the parsers matched something)', function () {
        expect(pins.size).to.equal(8);
        expect(sourceDefaults.size).to.equal(8);
    });

    it('pins every knob the source reads (row 33: no unpinned variable)', function () {
        expect(unpinned, `unpinned in deploy/rate-limits.conf: ${unpinned.join(', ') || 'none'}`)
            .to.deep.equal([]);
    });

    it('reads back every pinned name in the source (row 33: no orphaned pin)', function () {
        expect(orphaned, `orphaned in deploy/rate-limits.conf: ${orphaned.join(', ') || 'none'}`)
            .to.deep.equal([]);
    });

    it('keeps the app-wide fallback equal to the derived 1080 (row 32)', function () {
        expect(sourceDefaults.get('EXPLORER_RATE_LIMIT_RPM')).to.equal(1080);
        expect(pins.get('EXPLORER_RATE_LIMIT_RPM')).to.equal(1080);
    });

    it('keeps every source default equal to its pinned value, naming any drift (row 32)', function () {
        const message = drifted
            .map((d) => `${d.name}: source=${d.defaultValue} pinned=${d.pinnedValue}`)
            .join('; ');
        expect(drifted, message).to.deep.equal([]);
    });
});

describe('Security: Rate Limiting: pin-vs-source comparison helper (falsification fixtures)', function () {

    // These feed the same parse/compare helpers crafted text instead of the
    // real files, so the failure modes rows 32 and 33 exist to catch are
    // proven to actually surface, not just assumed from reading the code.

    it('names an unpinned variable when the source reads one the conf lacks', function () {
        const pins = parsePinnedLimits('Environment=EXPLORER_RATE_LIMIT_RPM=1080\n');
        const sourceDefaults = parseSourceLimits(
            "limit: parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 1080,\n" +
            "limit: parseInt(process.env.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM, 10) || 120,\n"
        );
        const { unpinned, orphaned, drifted } = comparePinsToSource(pins, sourceDefaults);
        expect(unpinned).to.deep.equal(['EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM']);
        expect(orphaned).to.deep.equal([]);
        expect(drifted).to.deep.equal([]);
    });

    it('names an orphaned pin when the conf keeps one the source no longer reads', function () {
        const pins = parsePinnedLimits(
            'Environment=EXPLORER_RATE_LIMIT_RPM=1080\n' +
            'Environment=EXPLORER_RETIRED_RATE_LIMIT_RPM=30\n'
        );
        const sourceDefaults = parseSourceLimits(
            "parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 1080"
        );
        const { unpinned, orphaned, drifted } = comparePinsToSource(pins, sourceDefaults);
        expect(orphaned).to.deep.equal(['EXPLORER_RETIRED_RATE_LIMIT_RPM']);
        expect(unpinned).to.deep.equal([]);
        expect(drifted).to.deep.equal([]);
    });

    it('names a drifted default when the source default no longer equals the pin', function () {
        const pins = parsePinnedLimits('Environment=EXPLORER_RATE_LIMIT_RPM=1080\n');
        const sourceDefaults = parseSourceLimits(
            "parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 500"
        );
        const { unpinned, orphaned, drifted } = comparePinsToSource(pins, sourceDefaults);
        expect(unpinned).to.deep.equal([]);
        expect(orphaned).to.deep.equal([]);
        expect(drifted).to.deep.equal([
            { name: 'EXPLORER_RATE_LIMIT_RPM', defaultValue: 500, pinnedValue: 1080 }
        ]);
    });

    it('reports a missing pin and a value drift together, not just the first one found', function () {
        const pins = parsePinnedLimits('Environment=EXPLORER_RATE_LIMIT_RPM=1080\n');
        const sourceDefaults = parseSourceLimits(
            "parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 500\n" +
            "parseInt(process.env.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM, 10) || 120"
        );
        const { unpinned, orphaned, drifted } = comparePinsToSource(pins, sourceDefaults);
        expect(unpinned).to.deep.equal(['EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM']);
        expect(drifted).to.deep.equal([
            { name: 'EXPLORER_RATE_LIMIT_RPM', defaultValue: 500, pinnedValue: 1080 }
        ]);
    });
});
