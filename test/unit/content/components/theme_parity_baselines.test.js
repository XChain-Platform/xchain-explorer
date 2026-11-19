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
 *
 * Every dated baseline in tools/theme-parity/ against the current probe.
 *
 * Each baseline-*.json either passes capture-baseline.js's validateBaseline or
 * is listed below with the exact refusal it earns. A probe census change then
 * fails here instead of silently leaving every baseline unusable as evidence.
 * While no baseline validates, AWAITING_VALID_BASELINE must say why; the first
 * one that validates must clear it, which arms a check that one stays usable.
 * AWAITING_COVERED_BASELINE applies the same rule to current component coverage.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateBaseline } = require('../../../../tools/theme-parity/capture-baseline.js');
const probeSchema = require('../../../../tools/theme-parity/parity-probe.js');

const DIR = path.resolve(__dirname, '..', '..', '..', '..', 'tools', 'theme-parity');
const TOOL = path.join(DIR, 'capture-baseline.js');

// Dated records the current probe refuses on purpose, with the refusal each earns
const KNOWN_INCOMPATIBLE = {
    // Captured with the 23-property census, before the 2026-10-07 property additions
    'baseline-2026-08-20.json': /Render census property count \(23\) incompatible with current probe \(29\)/,
    // Headless capture in a per-mode shape the builder never writes: no anchors, no probe schema
    'baseline-2026-10-12-classic.json': /Page coin_home\.anchors must have matched\/total form$/,
    // Probe schema v2 records rendered values for custom-property-only rules
    'baseline-2026-10-20.json': /Baseline schema version \(1\) incompatible with current probe \(2\)/,
};

// Why no baseline is usable evidence today: baseline-2026-10-20.json, the only builder-made
// testnet capture, is probe schema v1, and no schema v2 capture has landed yet
const AWAITING_VALID_BASELINE = 'probe schema v2 awaits a fresh custom-property-rule capture';
const AWAITING_COVERED_BASELINE = 'no current-probe capture includes component selector coverage';

// List the dated baseline files in the tool directory
function baselineFiles() {
    return fs.readdirSync(DIR).filter((name) => /^baseline-.*\.json$/.test(name)).sort();
}

// Read and parse one baseline file
function readBaseline(name) {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
}

// Count the baselines the current probe accepts, by running the validator on each
function validBaselineCount() {
    return baselineFiles().filter((name) => {
        try { return validateBaseline(readBaseline(name)) === true; }
        catch (_) { return false; }
    }).length;
}

// Count current-probe baselines that measure both page and component selectors
function coveredBaselineCount() {
    return baselineFiles().filter((name) => {
        const baseline = readBaseline(name);
        try { validateBaseline(baseline); }
        catch (_) { return false; }
        return baseline.coverage && baseline.coverage.pageLevel.selectors > 0 &&
            baseline.coverage.components.selectors > 0;
    }).length;
}

describe('theme parity baselines: every dated baseline is accounted for', function () {

    it('finds the dated baselines on disk', function () {
        // An empty directory would make every check below pass by iterating nothing
        assert.ok(baselineFiles().length >= Object.keys(KNOWN_INCOMPATIBLE).length);
    });

    it('validates each baseline or refuses it with its recorded reason', function () {
        for (const name of baselineFiles()) {
            const baseline = readBaseline(name);
            const expected = KNOWN_INCOMPATIBLE[name];
            // A file not in the table must pass the current probe outright
            if (!expected) {
                assert.equal(validateBaseline(baseline), true, `${name} must validate against the current probe`);
                continue;
            }
            assert.throws(() => validateBaseline(baseline), expected, `${name} must earn its recorded refusal`);
        }
    });

    it('keeps no table entry for a baseline that no longer exists', function () {
        const onDisk = new Set(baselineFiles());
        for (const name of Object.keys(KNOWN_INCOMPATIBLE))
            assert.ok(onDisk.has(name), `${name} is listed as incompatible but is not on disk`);
    });

    it('holds at least one baseline the current probe accepts, or records why not', function () {
        const valid = validBaselineCount();
        // Require a usable baseline once the reason is cleared
        if (AWAITING_VALID_BASELINE === null) {
            assert.ok(valid >= 1, 'no baseline-*.json validates against the current probe: recapture one per ' +
                'tools/theme-parity/README.md, or set AWAITING_VALID_BASELINE with a reason');
            return;
        }
        // Require a stated reason, and retire it as soon as a baseline validates
        assert.ok(typeof AWAITING_VALID_BASELINE === 'string' && AWAITING_VALID_BASELINE.trim(),
            'AWAITING_VALID_BASELINE must state why no baseline validates');
        assert.equal(valid, 0, 'a baseline now validates: set AWAITING_VALID_BASELINE to null to arm this check');
    });

    it('holds a valid baseline with component coverage, or records why not', function () {
        const covered = coveredBaselineCount();
        if (AWAITING_COVERED_BASELINE === null) {
            assert.ok(covered >= 1, 'no valid baseline measures page-level and component selectors');
            return;
        }
        assert.ok(typeof AWAITING_COVERED_BASELINE === 'string' && AWAITING_COVERED_BASELINE.trim(),
            'AWAITING_COVERED_BASELINE must state why coverage is missing');
        assert.equal(covered, 0,
            'a covered baseline now validates: set AWAITING_COVERED_BASELINE to null');
    });
});

describe('theme parity baselines: the classic record and the validator self-test', function () {

    it('fits every classic render key count to the current anchor and property census', function () {
        // keys = matched x properties + absent anchors, so matched must solve to a whole number
        const anchors = probeSchema.anchors.count, properties = probeSchema.properties.count;
        const classic = readBaseline('baseline-2026-10-12-classic.json');
        for (const [tag, page] of Object.entries(classic.pages)) {
            for (const mode of ['light', 'dark']) {
                const matched = (page[mode].rend.keys - anchors) / (properties - 1);
                assert.ok(Number.isInteger(matched) && matched >= 1 && matched <= anchors,
                    `${tag} ${mode} render keys (${page[mode].rend.keys}) do not fit the current census`);
            }
        }
    });

    it('passes the capture-baseline self-test', function () {
        const run = spawnSync(process.execPath, [TOOL, '--self-test'], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /capture-baseline self-test: \d+ passed, 0 failed/);
    });
});
