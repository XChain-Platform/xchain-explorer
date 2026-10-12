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

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function compatibleSchema(candidate, label = 'Capture') {
  object(candidate, `${label} probe schema`);
  object(candidate.anchors, `${label} anchor census`);
  object(candidate.properties, `${label} property census`);
  if (candidate.properties.count !== probeSchema.properties.count) {
    fail(`Render census property count (${candidate.properties.count}) incompatible with current probe ` +
      `(${probeSchema.properties.count})`);
  }
  if (candidate.anchors.count !== probeSchema.anchors.count) {
    fail(`Render census anchor count (${candidate.anchors.count}) incompatible with current probe ` +
      `(${probeSchema.anchors.count})`);
  }
  for (const part of ['anchors', 'properties']) {
    if (candidate[part].hash !== probeSchema[part].hash)
      fail(`${label} ${part} census does not match the current probe`);
  }
  if (candidate.version !== probeSchema.version)
    fail(`${label} schema version (${candidate.version}) incompatible with current probe ` +
      `(${probeSchema.version})`);
}

function hashRecord(value, label) {
  object(value, label);
  if (!/^[0-9a-f]{8}$/.test(value.hash)) fail(`${label}.hash must be an 8 digit lowercase hex hash`);
  if (!Number.isInteger(value.keys) || value.keys < 1) fail(`${label}.keys must be a positive integer`);
}

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

function buildBaseline(manifest, options) {
  object(manifest, 'Capture manifest');
  compatibleSchema(manifest.probe, 'Capture manifest');
  if (typeof manifest.phase !== 'string' || !manifest.phase) fail('Capture manifest phase must be non-empty');
  const pages = object(manifest.pages, 'Capture manifest pages');
  if (!Object.keys(pages).length) fail('Capture manifest contains no pages');

  const outputPages = {};
  for (const tag of Object.keys(pages).sort()) {
    const page = object(pages[tag], `Page ${tag}`);
    compatibleSchema(page.probe, `Page ${tag}`);
    if (typeof page.url !== 'string' || !page.url.startsWith('/')) fail(`Page ${tag}.url must be an absolute path`);
    const lightCensus = validateMode(page.light, `Page ${tag} light`);
    const darkCensus = validateMode(page.dark, `Page ${tag} dark`);
    if (page.light.anchors !== page.dark.anchors) fail(`Page ${tag} modes have different anchor counts`);
    if (page.light.cssRules !== page.dark.cssRules) fail(`Page ${tag} modes have different CSS rule counts`);
    if (page.light.rule.hash !== page.dark.rule.hash || page.light.rule.keys !== page.dark.rule.keys)
      fail(`Page ${tag} rule layer differs between modes and cannot be represented by one baseline`);
    if (page.light.rend.keys !== page.dark.rend.keys) fail(`Page ${tag} modes have different render key counts`);
    assert.deepEqual(lightCensus, darkCensus);
    outputPages[tag] = {
      url: page.url,
      anchors: page.light.anchors,
      cssRules: page.light.cssRules,
      rule: page.light.rule,
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
      rule: 'Properties declared by admitted first-party stylesheets, read on the first matching element.',
      rend: `A fixed census of ${probeSchema.anchors.count} selectors x ` +
        `${probeSchema.properties.count} properties, including an absence key for unmatched selectors.`,
    },
    pages: outputPages,
  };
}

function validateBaseline(baseline) {
  object(baseline, 'Baseline');
  if (baseline.probe && typeof baseline.probe === 'object') compatibleSchema(baseline.probe, 'Baseline');
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
  }
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
      light: mode('22222222', 'white | black'), dark: mode('33333333', 'black | white') } },
  };
}

function selfTest() {
  const tests = [
    () => assert.equal(probeSchema.properties.count, 29),
    () => assert.equal(buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' })
      .pages.home.rend.keys, 87),
    () => assert.throws(() => buildBaseline(fixture(23), { date: '2026-10-12', venue: 'self-test' }),
      /Render census property count \(23\) incompatible with current probe \(29\)/),
    () => {
      const capture = fixture(); capture.probe.properties.hash = '00000000';
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /properties census does not match/);
    },
    () => {
      const capture = fixture(); capture.pages.home.light.rend.keys = 75;
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /Render census property count \(23\) incompatible with current probe \(29\)/);
    },
    () => {
      const capture = fixture(); capture.pages.home.dark.rule.hash = '99999999';
      assert.throws(() => buildBaseline(capture, { date: '2026-10-12', venue: 'self-test' }),
        /rule layer differs between modes/);
    },
    () => validateBaseline(buildBaseline(fixture(), { date: '2026-10-12', venue: 'self-test' })),
    () => assert.throws(() => validateBaseline({ pages: {
      home: { anchors: '2/31', rend: { keys: 75 } },
    } }), /Render census property count \(23\) incompatible with current probe \(29\)/),
  ];
  tests.forEach((test) => test());
  process.stdout.write(`capture-baseline self-test: ${tests.length} passed, 0 failed\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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
