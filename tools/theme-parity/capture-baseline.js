#!/usr/bin/env node

/**********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const probeSchema = require('./parity-probe.js');

function fail(message) { throw new Error(message); }

function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value))
  fail(`${label} must be an object`); return value; }

function hexHash(value, label) { if (typeof value !== 'string' || !/^[0-9a-f]{8}$/.test(value))
  fail(`${label} must be an 8 digit lowercase hex hash`); }

function compatibleSchema(candidate, label = 'Capture') {
  object(candidate, `${label} probe schema`);
  object(candidate.anchors, `${label} anchor census`);
  object(candidate.properties, `${label} property census`);
  if (candidate.properties.count !== probeSchema.properties.count)
    fail(`Render census property count (${candidate.properties.count}) incompatible with current probe ` +
      `(${probeSchema.properties.count})`);
  if (candidate.anchors.count !== probeSchema.anchors.count)
    fail(`Render census anchor count (${candidate.anchors.count}) incompatible with current probe ` +
      `(${probeSchema.anchors.count})`);
  for (const part of ['anchors', 'properties']) {
    if (candidate[part].hash !== probeSchema[part].hash)
      fail(`${label} ${part} census does not match the current probe`);
  }
  if (candidate.version !== probeSchema.version)
    fail(`${label} schema version (${candidate.version}) incompatible with current probe ` +
      `(${probeSchema.version})`);
}

function hashRecord(value, label) { object(value, label); hexHash(value.hash, `${label}.hash`);
  if (!Number.isInteger(value.keys) || value.keys < 1) fail(`${label}.keys must be a positive integer`); }

function anchors(value, label) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) fail(`${label} must have matched/total form`);
  const matched = Number(match[1]), total = Number(match[2]);
  if (matched < 1 || matched > total) fail(`${label} has an invalid matched count`);
  if (total !== probeSchema.anchors.count)
    fail(`Render census anchor count (${total}) incompatible with current probe (${probeSchema.anchors.count})`);
  return { matched, total };
}

function inferredPropertyCount(keys, census, label) {
  const absent = census.total - census.matched;
  const measured = (keys - absent) / census.matched;
  if (!Number.isInteger(measured) || measured < 1) fail(`${label} has an impossible render key count (${keys})`);
  return measured;
}

function validateMode(mode, label) {
  object(mode, label);
  hashRecord(mode.rule, `${label}.rule`);
  hashRecord(mode.rend, `${label}.rend`);
  if (!Number.isInteger(mode.cssRules) || mode.cssRules < 1)
    fail(`${label}.cssRules must be a positive integer`);
  if (typeof mode.rendered !== 'string' || !mode.rendered) fail(`${label}.rendered must be non-empty`);
  const census = anchors(mode.anchors, `${label}.anchors`);
  const count = inferredPropertyCount(mode.rend.keys, census, label);
  if (count !== probeSchema.properties.count) {
    fail(`Render census property count (${count}) incompatible with current probe ` +
      `(${probeSchema.properties.count}) at ${label}`);
  }
  return census;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${label} must be a string array`);
  const sorted = Array.from(new Set(value)).sort();
  if (sorted.length !== value.length) fail(`${label} must not contain duplicates`);
  return sorted;
}
function coverageGroup(id) {
  if (/\/components\/[^/]+\/component\.css$/.test(id)) return 'components';
  if (/\/themes\//.test(id)) return 'themes';
  if (/\/(xchain|xchain-charts)\.css$/.test(id)) return 'pageLevel';
  fail(`Coverage sheet ${id} is outside the admitted stylesheet groups`);
}
function pageCoverage(value, label) {
  const sheets = object(object(value, label).sheets, `${label}.sheets`);
  if (!Object.keys(sheets).length) fail(`${label}.sheets must not be empty`);
  const out = {};
  for (const id of Object.keys(sheets).sort()) {
    const row = object(sheets[id], `${label}.sheets.${id}`);
    const selectors = stringList(row.selectors, `${label}.sheets.${id}.selectors`);
    const matched = stringList(row.matched, `${label}.sheets.${id}.matched`);
    if (!selectors.length) fail(`${label}.sheets.${id}.selectors must not be empty`);
    if (matched.some((selector) => !selectors.includes(selector))) fail(`${label}.sheets.${id}.matched must be a selector subset`);
    out[id] = { selectors, matched };
  }
  return out;
}
function coverageSummary(selectorLists, matchedSets) {
  const coverage = { sheets: {}, pageLevel: { selectors: 0, exercised: 0 },
    components: { selectors: 0, exercised: 0 }, themes: { selectors: 0, exercised: 0 } };
  for (const id of Object.keys(selectorLists).sort()) {
    const selectors = selectorLists[id], matched = matchedSets[id];
    const row = { selectors: selectors.length, exercised: matched.size,
      neverMatched: selectors.filter((selector) => !matched.has(selector)) };
    coverage.sheets[id] = row;
    const group = coverageGroup(id);
    coverage[group].selectors += row.selectors;
    coverage[group].exercised += row.exercised;
  }
  return coverage;
}
function validateCoverageSummary(coverage) {
  const sheets = object(object(coverage, 'Baseline coverage').sheets, 'Baseline coverage.sheets');
  if (!Object.keys(sheets).length) fail('Baseline coverage.sheets must not be empty');
  const totals = { pageLevel: { selectors: 0, exercised: 0 }, components: { selectors: 0, exercised: 0 }, themes: { selectors: 0, exercised: 0 } };
  for (const id of Object.keys(sheets)) {
    const row = object(sheets[id], `Baseline coverage.sheets.${id}`);
    if (!Number.isInteger(row.selectors) || row.selectors < 1 || !Number.isInteger(row.exercised) || row.exercised < 0 || row.exercised > row.selectors)
      fail(`Baseline coverage.sheets.${id} has invalid selector arithmetic`);
    const never = stringList(row.neverMatched, `Baseline coverage.sheets.${id}.neverMatched`);
    if (never.length !== row.selectors - row.exercised) fail(`Baseline coverage.sheets.${id}.neverMatched count is inconsistent`);
    const group = totals[coverageGroup(id)]; group.selectors += row.selectors; group.exercised += row.exercised;
  }
  for (const group of Object.keys(totals)) {
    const actual = object(coverage[group], `Baseline coverage.${group}`);
    if (actual.selectors !== totals[group].selectors || actual.exercised !== totals[group].exercised)
      fail(`Baseline coverage.${group} totals are inconsistent`);
  }
}

function mergePageCoverage(value, tag, selectorLists, matchedSets) {
  const coverage = pageCoverage(value, `Page ${tag}.coverage`);
  for (const id of Object.keys(coverage)) {
    if (selectorLists[id] && JSON.stringify(selectorLists[id]) !== JSON.stringify(coverage[id].selectors))
      fail(`Page ${tag}.coverage has a different selector list for ${id}`);
    selectorLists[id] = coverage[id].selectors;
    const matched = matchedSets[id] || (matchedSets[id] = new Set());
    coverage[id].matched.forEach((selector) => matched.add(selector));
  }
}

function buildBaseline(manifest, options) {
  object(manifest, 'Capture manifest');
  compatibleSchema(manifest.probe, 'Capture manifest');
  if (typeof manifest.phase !== 'string' || !manifest.phase) fail('Capture manifest phase must be non-empty');
  const pages = object(manifest.pages, 'Capture manifest pages');
  if (!Object.keys(pages).length) fail('Capture manifest contains no pages');

  const outputPages = {}, selectorLists = {}, matchedSets = {};
  for (const tag of Object.keys(pages).sort()) {
    const page = object(pages[tag], `Page ${tag}`);
    compatibleSchema(page.probe, `Page ${tag}`);
    if (typeof page.url !== 'string' || !page.url.startsWith('/')) fail(`Page ${tag}.url must be an absolute path`);
    const lightCensus = validateMode(page.light, `Page ${tag} light`);
    const darkCensus = validateMode(page.dark, `Page ${tag} dark`);
    if (page.light.anchors !== page.dark.anchors) fail(`Page ${tag} modes have different anchor counts`);
    if (page.light.cssRules !== page.dark.cssRules) fail(`Page ${tag} modes have different CSS rule counts`);
    // Record the rule hash per mode (mode-following tokens move it); a key-count split means different rules matched
    if (page.light.rule.keys !== page.dark.rule.keys) fail(`Page ${tag} modes have different rule key counts`);
    if (page.light.rend.keys !== page.dark.rend.keys) fail(`Page ${tag} modes have different render key counts`);
    assert.deepEqual(lightCensus, darkCensus);
    mergePageCoverage(page.coverage, tag, selectorLists, matchedSets);
    outputPages[tag] = {
      url: page.url,
      anchors: page.light.anchors,
      cssRules: page.light.cssRules,
      rule: {
        light: page.light.rule.hash,
        dark: page.dark.rule.hash,
        keys: page.light.rule.keys,
      },
      rend: {
        light: page.light.rend.hash,
        dark: page.dark.rend.hash,
        keys: page.light.rend.keys,
      },
      rendered: { light: page.light.rendered, dark: page.dark.rendered },
    };
  }

  return {
    note: 'Parity baseline captured with a schema-identified probe. ' +
      'Compare only with captures whose probe schema matches.',
    captured: options.date,
    venue: options.venue,
    phase: manifest.phase,
    probe: probeSchema,
    layers: {
      rule: 'Properties declared by admitted first-party stylesheets, read on the first matching element, ' +
        'hashed per mode because a declared value that resolves through a mode-following token differs by mode.',
      rend: `A fixed census of ${probeSchema.anchors.count} selectors x ` +
        `${probeSchema.properties.count} properties, including an absence key for unmatched selectors.`,
    },
    coverage: coverageSummary(selectorLists, matchedSets),
    pages: outputPages,
  };
}

function validateBaseline(baseline) {
  object(baseline, 'Baseline');
  const pages = object(baseline.pages, 'Baseline pages');
  if (!Object.keys(pages).length) fail('Baseline contains no pages');
  for (const tag of Object.keys(pages)) {
    const page = object(pages[tag], `Page ${tag}`);
    const census = anchors(page.anchors, `Page ${tag}.anchors`);
    const rend = object(page.rend, `Page ${tag}.rend`);
    if (!Number.isInteger(rend.keys)) fail(`Page ${tag}.rend.keys must be an integer`);
    const count = inferredPropertyCount(rend.keys, census, `Page ${tag}`);
    if (count !== probeSchema.properties.count) {
      fail(`Render census property count (${count}) incompatible with current probe ` +
        `(${probeSchema.properties.count}) at Page ${tag}`);
    }
    for (const mode of ['light', 'dark']) hexHash(rend[mode], `Page ${tag}.rend.${mode}`);
    // Check per-mode hashes after census checks, so a legacy file keeps its count message
    const rule = object(page.rule, `Page ${tag}.rule`);
    for (const mode of ['light', 'dark']) hexHash(rule[mode], `Page ${tag}.rule.${mode}`);
    if (!Number.isInteger(rule.keys) || rule.keys < 1) fail(`Page ${tag}.rule.keys must be a positive integer`);
  }
  // Require the probe schema, missing or legacy string included (after the page loop, so a legacy file keeps its count message)
  compatibleSchema(baseline.probe, 'Baseline');
  if (baseline.coverage !== undefined) validateCoverageSummary(baseline.coverage);
  return true;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--input' || arg === '--output' || arg === '--date' || arg === '--venue' || arg === '--check') {
      if (!argv[i + 1]) fail(`${arg} requires a value`);
      options[arg.slice(2)] = argv[++i];
    } else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function fixture(propertyCount = probeSchema.properties.count) {
  const matched = 2, absent = probeSchema.anchors.count - matched;
  const keys = matched * propertyCount + absent;
  const mode = (rendHash, rendered) => ({
    rule: { hash: '11111111', keys: 3 }, rend: { hash: rendHash, keys },
    anchors: `${matched}/${probeSchema.anchors.count}`, cssRules: 4, rendered,
  });
  const schema = JSON.parse(JSON.stringify(probeSchema));
  schema.properties.count = propertyCount;
  return {
    phase: 'before', probe: schema,
    pages: { home: { url: '/RDOGE', probe: schema,
      light: mode('22222222', 'white | black'), dark: mode('33333333', 'black | white'),
      coverage: { sheets: { '/css/xchain.css': { selectors: ['body', '.card'], matched: ['body'] } } } } },
  };
}

function baselineFixture() { return JSON.parse(JSON.stringify(
  buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' }))); }

function hashSelfTests() {
  return [
    () => { const baseline = baselineFixture(); delete baseline.pages.home.rend.light;
      delete baseline.pages.home.rend.dark;
      assert.throws(() => validateBaseline(baseline), /Page home\.rend\.light must be an 8 digit/); },
    () => { const baseline = baselineFixture(); delete baseline.pages.home.rend.dark; assert.throws(
      () => validateBaseline(baseline), /Page home\.rend\.dark must be an 8 digit/); },
    () => { for (const value of ['ABCDEF12', '2222222', 22222222]) { const baseline = baselineFixture();
      baseline.pages.home.rend.light = value; assert.throws(
        () => validateBaseline(baseline), /Page home\.rend\.light must be an 8 digit/); } },
    () => { const baseline = baselineFixture(); baseline.pages.home.rule.light = 11111111; assert.throws(
      () => validateBaseline(baseline), /Page home\.rule\.light must be an 8 digit/); },
  ];
}

function coverageSelfTests() {
  return [
    () => { const capture = fixture(); delete capture.pages.home.coverage;
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }), /coverage must be an object/);
    },
    () => { const capture = fixture();
      capture.pages.home.coverage.sheets['/css/xchain.css'] = { selectors: [], matched: [] };
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }), /selectors must not be empty/);
    },
    () => { const capture = fixture(); capture.pages.other = JSON.parse(JSON.stringify(capture.pages.home));
      capture.pages.other.coverage.sheets['/css/xchain.css'].selectors.push('.footer');
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }), /different selector list/);
    },
    () => { const capture = fixture(); capture.pages.other = JSON.parse(JSON.stringify(capture.pages.home));
      capture.pages.other.coverage.sheets['/css/xchain.css'].matched = ['.card'];
      const coverage = buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }).coverage;
      assert.deepEqual(coverage.pageLevel, { selectors: 2, exercised: 2 });
    },
    () => { const baseline = buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' });
      baseline.coverage.pageLevel.exercised = 2;
      assert.throws(() => validateBaseline(baseline), /pageLevel totals are inconsistent/);
    },
    () => { const baseline = buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' });
      baseline.coverage.sheets['/css/xchain.css'] = { selectors: 0, exercised: 0, neverMatched: [] };
      baseline.coverage.pageLevel = { selectors: 0, exercised: 0 };
      assert.throws(() => validateBaseline(baseline), /invalid selector arithmetic/);
    },
    () => { const baseline = buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' });
      delete baseline.coverage;
      assert.equal(validateBaseline(baseline), true);
    },
  ];
}

function selfTest() {
  const tests = [
    () => assert.equal(probeSchema.properties.count, 29),
    () => assert.equal(buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' })
      .pages.home.rend.keys, 87),
    () => assert.throws(() => buildBaseline(fixture(23), { date: '2026-10-12', venue: 'self-test' }),
      /Render census property count \(23\) incompatible with current probe \(29\)/),
    () => { const capture = fixture(); capture.probe.properties.hash = '00000000';
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /properties census does not match/);
    },
    () => { const capture = fixture(); capture.pages.home.light.rend.keys = 75;
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /Render census property count \(23\) incompatible with current probe \(29\)/);
    },
    () => { const capture = fixture(); capture.pages.home.dark.rule.hash = '99999999';
      const rule = buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }).pages.home.rule;
      assert.deepEqual(rule, { light: '11111111', dark: '99999999', keys: 3 });
    },
    () => { const capture = fixture(); capture.pages.home.dark.rule.keys = 4;
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /different rule key counts/);
    },
    () => { const baseline = baselineFixture();
      baseline.pages.home.rule = { hash: '11111111', keys: 3 };
      assert.throws(() => validateBaseline(baseline), /Page home\.rule\.light must be an 8 digit/);
    },
    () => validateBaseline(buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' })),
    () => assert.throws(() => validateBaseline({ pages: {
      home: { anchors: '2/31', rend: { keys: 75 } },
    } }), /Render census property count \(23\) incompatible with current probe \(29\)/),
    () => { const baseline = baselineFixture();
      delete baseline.probe;
      assert.throws(() => validateBaseline(baseline), /Baseline probe schema must be an object/);
    },
    () => { const baseline = baselineFixture();
      baseline.probe = 'tools/theme-parity/parity-probe.js';
      assert.throws(() => validateBaseline(baseline), /Baseline probe schema must be an object/);
    },
    () => { const baseline = baselineFixture();
      baseline.probe.properties.hash = '00000000';
      assert.throws(() => validateBaseline(baseline), /properties census does not match/);
    },
  ];
  tests.push(...hashSelfTests(), ...coverageSelfTests());
  tests.forEach((test) => test());
  process.stdout.write(`capture-baseline self-test: ${tests.length} passed, 0 failed\n`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (options.check) {
    validateBaseline(readJson(options.check));
    process.stdout.write(`${options.check}: compatible with current probe\n`);
    return;
  }
  if (!options.input || !options.date || !options.venue) {
    fail('Usage: capture-baseline.js --input FILE --date YYYY-MM-DD --venue NAME [--output FILE]');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) fail('--date must use YYYY-MM-DD form');
  const baseline = buildBaseline(readJson(options.input), options);
  const json = `${JSON.stringify(baseline, null, 2)}\n`;
  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), json, { flag: 'wx' });
    process.stdout.write(`${options.output}: baseline written\n`);
  } else process.stdout.write(json);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`capture-baseline: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildBaseline, validateBaseline };
